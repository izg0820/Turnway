-- Read the current waiting state.
-- ARGV: [1] prefix, [2] userId, [3] passId, [4] retentionMs, [5] pruneLimit
local userId = ARGV[2]
local passId = ARGV[3]
local retention = tonumber(ARGV[4])
local pruneLimit = tonumber(ARGV[5])

local now = now_ms()
prune_expired(now, pruneLimit, retention)

local pass = read_pass(passId)
if not pass then
  return fail('PASS_NOT_FOUND')
end
if pass['owner'] ~= userId then
  return fail('PASS_OWNER_MISMATCH')
end

return reply(resolve_state(passId, pass, now, retention))
