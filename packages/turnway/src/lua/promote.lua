-- Admission pass: prune expired entries, compute free capacity, then promote the head of the queue.
-- ARGV: [1] prefix, [2] capacity, [3] sessionTtlMs, [4] maxSessionDurationMs,
--       [5] retentionMs, [6] batchSize, [7] pruneLimit
local capacity = tonumber(ARGV[2])
local sessionTtl = tonumber(ARGV[3])
local maxSessionDuration = tonumber(ARGV[4])
local retention = tonumber(ARGV[5])
local batchSize = tonumber(ARGV[6])
local pruneLimit = tonumber(ARGV[7])

local now = now_ms()
local expired = prune_expired(now, pruneLimit, retention)

-- Incomplete cleanup inflates the active count and admits fewer users. Overshooting capacity is never allowed
local activeCount = redis.call('ZCARD', KEY_ACTIVE)
local free = capacity - activeCount

if free <= 0 then
  return reply({
    ok = true,
    admitted = 0,
    expired = expired,
    availableSlots = 0,
  })
end

local take = free
if take > batchSize then take = batchSize end

local admitted = 0
local scanned = 0
local scanLimit = take + pruneLimit

while admitted < take and scanned < scanLimit do
  local head = redis.call('ZRANGE', KEY_WAITING, 0, 0)
  if #head == 0 then break end

  local passId = head[1]
  scanned = scanned + 1

  local pass = read_pass(passId)
  local expiry = redis.call('ZSCORE', KEY_WAITING_EXPIRY, passId)
  local usable = pass and pass['status'] == 'WAITING' and expiry and now < tonumber(expiry)

  if not usable then
    local owner = ''
    if pass then owner = pass['owner'] or '' end
    finish_pass(passId, owner, 'EXPIRED', now, retention)
    expired = expired + 1
  else
    local owner = pass['owner']
    local deadline = now + maxSessionDuration
    local sessionExpiry = now + sessionTtl
    if sessionExpiry > deadline then sessionExpiry = deadline end

    redis.call('ZREM', KEY_WAITING, passId)
    redis.call('ZREM', KEY_WAITING_EXPIRY, passId)
    redis.call('ZADD', KEY_ACTIVE, sessionExpiry, passId)

    local pKey = pass_key(passId)
    redis.call('HSET', pKey,
      'status', 'ADMITTED',
      'admittedAt', now,
      'expiresAt', sessionExpiry,
      'sessionEndsAt', deadline)
    redis.call('PEXPIRE', pKey, maxSessionDuration + retention)
    redis.call('SET', user_key(owner), passId, 'PX', maxSessionDuration + retention)

    admitted = admitted + 1
  end
end

local remaining = capacity - redis.call('ZCARD', KEY_ACTIVE)
if remaining < 0 then remaining = 0 end

return reply({
  ok = true,
  admitted = admitted,
  expired = expired,
  availableSlots = remaining,
})
