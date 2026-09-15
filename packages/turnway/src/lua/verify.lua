-- Admission check only. A read-only decision that neither extends a session nor consumes capacity.
-- ARGV: [1] prefix, [2] userId, [3] passId
local userId = ARGV[2]
local passId = ARGV[3]

local now = now_ms()

local pass = read_pass(passId)
if not pass then
  return fail('PASS_NOT_FOUND')
end
if pass['owner'] ~= userId then
  return fail('PASS_OWNER_MISMATCH')
end

local status = pass['status']

if status == 'ADMITTED' then
  local expiry = redis.call('ZSCORE', KEY_ACTIVE, passId)
  if expiry and now < tonumber(expiry) then
    return reply(snapshot(passId, pass, 'ADMITTED', {
      admittedAt = tonumber(pass['admittedAt']) or 0,
      expiresAt = tonumber(expiry),
      sessionEndsAt = tonumber(pass['sessionEndsAt']) or 0,
    }))
  end
  -- Past its expiry the pass reads as EXPIRED even before cleanup (no writes)
  return reply(snapshot(passId, pass, 'EXPIRED', { endedAt = now }))
end

if status == 'WAITING' then
  local expiry = redis.call('ZSCORE', KEY_WAITING_EXPIRY, passId)
  if expiry and now < tonumber(expiry) then
    local rank = redis.call('ZRANK', KEY_WAITING, passId)
    return reply(snapshot(passId, pass, 'WAITING', {
      position = (rank or 0) + 1,
      expiresAt = tonumber(expiry),
    }))
  end
  return reply(snapshot(passId, pass, 'EXPIRED', { endedAt = now }))
end

return reply(snapshot(passId, pass, status, { endedAt = tonumber(pass['endedAt']) or now }))
