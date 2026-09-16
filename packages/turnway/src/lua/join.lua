-- Join the queue.
-- ARGV: [1] prefix, [2] userId, [3] newPassId, [4] waitingTtlMs, [5] retentionMs, [6] pruneLimit
local userId = ARGV[2]
local newPassId = ARGV[3]
local waitingTtl = tonumber(ARGV[4])
local retention = tonumber(ARGV[5])
local pruneLimit = tonumber(ARGV[6])

local now = now_ms()
prune_expired(now, pruneLimit, retention)

local uKey = user_key(userId)
local existingId = redis.call('GET', uKey)

if existingId then
  local pass = read_pass(existingId)
  if pass and pass['owner'] == userId then
    local state = resolve_state(existingId, pass, now, retention)
    -- A live pass means a retry or refresh, so return it unchanged
    if state['state'] == 'WAITING' or state['state'] == 'ADMITTED' then
      return reply(state)
    end
  end
  -- Clear the leftover mapping of a finished, expired, or missing pass
  drop_indexes(existingId)
  release_user(userId, existingId)
end

-- A new join always goes to the back of the queue, even with free capacity
local seq = redis.call('INCR', KEY_SEQ)
local expiresAt = now + waitingTtl
local pKey = pass_key(newPassId)

redis.call('HSET', pKey,
  'owner', userId,
  'status', 'WAITING',
  'seq', seq,
  'joinedAt', now,
  'expiresAt', expiresAt)
redis.call('PEXPIRE', pKey, waitingTtl + retention)
redis.call('SET', uKey, newPassId, 'PX', waitingTtl + retention)
redis.call('ZADD', KEY_WAITING, seq, newPassId)
redis.call('ZADD', KEY_WAITING_EXPIRY, expiresAt, newPassId)

local rank = redis.call('ZRANK', KEY_WAITING, newPassId)

return reply({
  ok = true,
  state = 'WAITING',
  passId = newPassId,
  userId = userId,
  sequence = seq,
  joinedAt = now,
  position = (rank or 0) + 1,
  expiresAt = expiresAt,
})
