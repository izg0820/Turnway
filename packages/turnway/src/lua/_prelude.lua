-- Shared helpers prepended to every room script.
-- KEYS: [1] seq, [2] waiting, [3] waiting-expiry, [4] active
-- ARGV[1] is always the room key prefix.

local KEY_SEQ = KEYS[1]
local KEY_WAITING = KEYS[2]
local KEY_WAITING_EXPIRY = KEYS[3]
local KEY_ACTIVE = KEYS[4]
local PREFIX = ARGV[1]

-- Epoch ms from Redis TIME. Keeps expiry decisions off each instance's clock
local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function pass_key(passId)
  return PREFIX .. 'pass:' .. passId
end

local function user_key(userId)
  return PREFIX .. 'user:' .. userId
end

local function reply(payload)
  return cjson.encode(payload)
end

local function fail(code, extra)
  local out = { ok = false, code = code }
  if extra then
    for k, v in pairs(extra) do out[k] = v end
  end
  return reply(out)
end

-- Read the pass hash. nil when it does not exist
local function read_pass(passId)
  local raw = redis.call('HGETALL', pass_key(passId))
  if #raw == 0 then return nil end
  local pass = {}
  for i = 1, #raw, 2 do
    pass[raw[i]] = raw[i + 1]
  end
  return pass
end

-- Remove from the waiting and active indexes
local function drop_indexes(passId)
  redis.call('ZREM', KEY_WAITING, passId)
  redis.call('ZREM', KEY_WAITING_EXPIRY, passId)
  redis.call('ZREM', KEY_ACTIVE, passId)
end

-- Drop the user mapping only when the pass id matches.
-- Stops cleanup of an old pass from clearing a freshly issued mapping
local function release_user(userId, passId)
  if not userId or userId == '' then return end
  local key = user_key(userId)
  if redis.call('GET', key) == passId then
    redis.call('DEL', key)
  end
end

-- Move a pass to a terminal state (LEFT/EXPIRED) and apply the retention window
local function finish_pass(passId, owner, state, now, retentionMs)
  drop_indexes(passId)
  release_user(owner, passId)
  local key = pass_key(passId)
  if redis.call('EXISTS', key) == 1 then
    redis.call('HSET', key, 'status', state, 'endedAt', now)
    redis.call('PEXPIRE', key, retentionMs)
  end
end

-- Build the common reply payload
local function snapshot(passId, pass, state, extra)
  local out = {
    ok = true,
    state = state,
    passId = passId,
    userId = pass['owner'],
    sequence = tonumber(pass['seq']) or 0,
    joinedAt = tonumber(pass['joinedAt']) or 0,
  }
  if extra then
    for k, v in pairs(extra) do out[k] = v end
  end
  return out
end

-- Remove up to `limit` entries with expiry at or before `now`
local function prune_index(indexKey, now, limit, retentionMs)
  if limit <= 0 then return 0 end

  local stale = redis.call('ZRANGEBYSCORE', indexKey, '-inf', now, 'LIMIT', 0, limit)
  for i = 1, #stale do
    local passId = stale[i]
    local owner = redis.call('HGET', pass_key(passId), 'owner')
    finish_pass(passId, owner or '', 'EXPIRED', now, retentionMs)
  end

  return #stale
end

-- Clean active entries first, then waiting entries within the remaining budget.
-- Admission and stats exclude expired sessions even before cleanup.
local function prune_expired(now, limit, retentionMs)
  if limit <= 0 then return 0 end

  local removed = prune_index(KEY_ACTIVE, now, limit, retentionMs)
  return removed + prune_index(KEY_WAITING_EXPIRY, now, limit - removed, retentionMs)
end

-- Resolve the current state. Past its expiry a pass becomes EXPIRED even before cleanup runs
local function resolve_state(passId, pass, now, retentionMs)
  local status = pass['status']

  if status == 'WAITING' then
    local expiry = redis.call('ZSCORE', KEY_WAITING_EXPIRY, passId)
    if expiry and now < tonumber(expiry) then
      local rank = redis.call('ZRANK', KEY_WAITING, passId)
      return snapshot(passId, pass, 'WAITING', {
        position = (rank or 0) + 1,
        expiresAt = tonumber(expiry),
      })
    end
    finish_pass(passId, pass['owner'], 'EXPIRED', now, retentionMs)
    return snapshot(passId, pass, 'EXPIRED', { endedAt = now })
  end

  if status == 'ADMITTED' then
    local expiry = redis.call('ZSCORE', KEY_ACTIVE, passId)
    if expiry and now < tonumber(expiry) then
      return snapshot(passId, pass, 'ADMITTED', {
        admittedAt = tonumber(pass['admittedAt']) or 0,
        expiresAt = tonumber(expiry),
        sessionEndsAt = tonumber(pass['sessionEndsAt']) or 0,
      })
    end
    finish_pass(passId, pass['owner'], 'EXPIRED', now, retentionMs)
    return snapshot(passId, pass, 'EXPIRED', { endedAt = now })
  end

  return snapshot(passId, pass, status, { endedAt = tonumber(pass['endedAt']) or now })
end
