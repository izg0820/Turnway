-- Heartbeat. Extends live sessions only; an expired session is never revived.
-- ARGV: [1] prefix, [2] userId, [3] passId, [4] waitingTtlMs, [5] sessionTtlMs,
--       [6] retentionMs, [7] pruneLimit
local userId = ARGV[2]
local passId = ARGV[3]
local waitingTtl = tonumber(ARGV[4])
local sessionTtl = tonumber(ARGV[5])
local retention = tonumber(ARGV[6])
local pruneLimit = tonumber(ARGV[7])

local now = now_ms()
prune_expired(now, pruneLimit, retention)

local pass = read_pass(passId)
if not pass then
  return fail('PASS_NOT_FOUND')
end
if pass['owner'] ~= userId then
  return fail('PASS_OWNER_MISMATCH')
end

local status = pass['status']
local pKey = pass_key(passId)

if status == 'WAITING' then
  local expiry = redis.call('ZSCORE', KEY_WAITING_EXPIRY, passId)
  if (not expiry) or now >= tonumber(expiry) then
    finish_pass(passId, userId, 'EXPIRED', now, retention)
    return reply(snapshot(passId, pass, 'EXPIRED', { endedAt = now }))
  end

  local nextExpiry = now + waitingTtl
  redis.call('ZADD', KEY_WAITING_EXPIRY, nextExpiry, passId)
  redis.call('PEXPIRE', pKey, waitingTtl + retention)
  redis.call('SET', user_key(userId), passId, 'PX', waitingTtl + retention)

  local rank = redis.call('ZRANK', KEY_WAITING, passId)
  return reply(snapshot(passId, pass, 'WAITING', {
    position = (rank or 0) + 1,
    expiresAt = nextExpiry,
  }))
end

if status == 'ADMITTED' then
  local expiry = redis.call('ZSCORE', KEY_ACTIVE, passId)
  if (not expiry) or now >= tonumber(expiry) then
    finish_pass(passId, userId, 'EXPIRED', now, retention)
    return reply(snapshot(passId, pass, 'EXPIRED', { endedAt = now }))
  end

  -- A heartbeat cannot push past the max stay measured from first admission
  local deadline = tonumber(pass['sessionEndsAt']) or now
  local nextExpiry = now + sessionTtl
  if nextExpiry > deadline then nextExpiry = deadline end

  if nextExpiry <= now then
    finish_pass(passId, userId, 'EXPIRED', now, retention)
    return reply(snapshot(passId, pass, 'EXPIRED', { endedAt = now }))
  end

  redis.call('ZADD', KEY_ACTIVE, nextExpiry, passId)
  redis.call('PEXPIRE', pKey, (nextExpiry - now) + retention)
  redis.call('SET', user_key(userId), passId, 'PX', (nextExpiry - now) + retention)

  return reply(snapshot(passId, pass, 'ADMITTED', {
    admittedAt = tonumber(pass['admittedAt']) or 0,
    expiresAt = nextExpiry,
    sessionEndsAt = deadline,
  }))
end

return reply(snapshot(passId, pass, status, { endedAt = tonumber(pass['endedAt']) or now }))
