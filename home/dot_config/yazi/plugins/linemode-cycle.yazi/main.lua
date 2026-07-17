--- @sync entry
-- Cycle the current listing's linemode. Bound to `M` in keymap.toml.
-- The module is required once and cached, so `idx` persists across keypresses.
local MODES = { "size", "mtime", "permissions", "none" }
local idx = 1

local function entry()
	idx = idx % #MODES + 1
	ya.emit("linemode", { MODES[idx] })
end

return { entry = entry }
