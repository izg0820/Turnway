-- Register the room config. Fails as a conflict when a different config is already applied.
-- KEYS: [1] config, ARGV: field/value pairs
local key = KEYS[1]
local existing = redis.call('HGETALL', key)

if #existing == 0 then
  redis.call('HSET', key, unpack(ARGV))
  return cjson.encode({ ok = true, applied = true })
end

local current = {}
for i = 1, #existing, 2 do
  current[existing[i]] = existing[i + 1]
end

local conflicts = {}
for i = 1, #ARGV, 2 do
  local field = ARGV[i]
  local value = ARGV[i + 1]
  if current[field] ~= value then
    conflicts[#conflicts + 1] = field
  end
end

if #conflicts > 0 then
  return cjson.encode({
    ok = false,
    code = 'ROOM_CONFIG_CONFLICT',
    conflicts = conflicts,
    current = current,
  })
end

return cjson.encode({ ok = true, applied = false })
