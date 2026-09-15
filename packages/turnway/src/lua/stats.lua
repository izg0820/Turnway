-- Live waiting and admitted counts. Uses the expiry indexes to skip entries cleanup has not reached yet.
-- ARGV: [1] prefix, [2] capacity, [3] retentionMs, [4] pruneLimit
local capacity = tonumber(ARGV[2])
local retention = tonumber(ARGV[3])
local pruneLimit = tonumber(ARGV[4])

local now = now_ms()
prune_expired(now, pruneLimit, retention)

local bound = string.format('(%d', now)
local waiting = redis.call('ZCOUNT', KEY_WAITING_EXPIRY, bound, '+inf')
local admitted = redis.call('ZCOUNT', KEY_ACTIVE, bound, '+inf')

local remaining = capacity - admitted
if remaining < 0 then remaining = 0 end

return reply({
  ok = true,
  waiting = waiting,
  admitted = admitted,
  availableSlots = remaining,
})
