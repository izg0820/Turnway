-- Cancel a wait or leave a session. Repeat calls within the retention window do not change the state.
-- ARGV: [1] prefix, [2] userId, [3] passId, [4] retentionMs
local userId = ARGV[2]
local passId = ARGV[3]
local retention = tonumber(ARGV[4])

local now = now_ms()

local pass = read_pass(passId)
if not pass then
  return fail('PASS_NOT_FOUND')
end
if pass['owner'] ~= userId then
  return fail('PASS_OWNER_MISMATCH')
end

-- Reading only the hash status would turn a TTL-expired pass into LEFT.
-- Checking the expiry index too makes the outcome independent of when cleanup runs
local resolved = resolve_state(passId, pass, now, retention)

if resolved['state'] == 'WAITING' or resolved['state'] == 'ADMITTED' then
  finish_pass(passId, userId, 'LEFT', now, retention)
  return reply(snapshot(passId, pass, 'LEFT', { endedAt = now }))
end

-- A pass already finished, or just confirmed expired, touches neither capacity nor anyone else
return reply(resolved)
