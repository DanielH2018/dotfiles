-- WezTerm configuration — WINDOWS ONLY (chezmoi ignores this on non-Windows).
-- Mirrors the Ghostty config used on macOS/Linux (~/.config/ghostty/config) as closely
-- as WezTerm's Lua allows: same font, Catppuccin Mocha, padding, cursor, scrollback, and
-- the shift+enter -> newline binding for Claude Code. Keep the two in sync by hand.

local wezterm = require("wezterm")
local act = wezterm.action
local config = wezterm.config_builder()

-- ---------------------------------------------------------------------------
-- FONT  (Ghostty: IosevkaTerm Nerd Font Mono Bold @ 16, +liga +kern +calt +ss01 +ss02)
-- Installed system-wide via chezmoi; Windows registers the Mono family as "IosevkaTerm
-- NFM", so list the full name first and the abbreviation as a fallback.
-- ---------------------------------------------------------------------------
config.font = wezterm.font_with_fallback({
	{ family = "IosevkaTerm Nerd Font Mono", weight = "Bold" },
	{ family = "IosevkaTerm NFM", weight = "Bold" },
})
config.font_size = 16.0
config.harfbuzz_features = { "liga", "kern", "calt", "ss01=1", "ss02=1" }

-- ---------------------------------------------------------------------------
-- THEME  (Ghostty: theme = "Catppuccin Mocha") — built into WezTerm.
-- ---------------------------------------------------------------------------
config.color_scheme = "Catppuccin Mocha"

-- ---------------------------------------------------------------------------
-- CURSOR  (Ghostty: block, blink, cursor-color #fabd2f) — colors merge over the scheme.
-- ---------------------------------------------------------------------------
config.default_cursor_style = "BlinkingBlock"
config.cursor_blink_rate = 500
config.colors = {
	cursor_bg = "#fabd2f",
	cursor_border = "#fabd2f",
	cursor_fg = "#1e1e2e",
}

-- ---------------------------------------------------------------------------
-- WINDOW / BEHAVIOR  (Ghostty: 120x24, padding 20, scrollback 100000, no close confirm)
-- ---------------------------------------------------------------------------
config.initial_cols = 120
config.initial_rows = 24
config.window_padding = { left = 20, right = 20, top = 20, bottom = 20 }
config.window_background_opacity = 1.0
config.window_close_confirmation = "NeverPrompt"
config.scrollback_lines = 100000
config.hide_mouse_cursor_when_typing = true
config.audible_bell = "SystemBeep"

-- ---------------------------------------------------------------------------
-- SHELL  — launch Git Bash (login + interactive), matching the Git-Bash-centric setup.
-- ---------------------------------------------------------------------------
config.default_prog = { "C:\\Program Files\\Git\\bin\\bash.exe", "-l", "-i" }

-- ---------------------------------------------------------------------------
-- KEYBINDINGS  — mirror the Ghostty binds, mapping macOS cmd -> Windows CTRL+SHIFT.
-- The critical one (identical to Ghostty) is shift+enter -> newline for Claude Code.
-- ---------------------------------------------------------------------------
config.keys = {
	-- Claude Code multiline (Ghostty: shift+enter=text:\n)
	{ key = "Enter", mods = "SHIFT", action = act.SendString("\n") },
	-- Reload config (Ghostty: cmd+shift+r)
	{ key = "R", mods = "CTRL|SHIFT", action = act.ReloadConfiguration },
	-- Clipboard (Ghostty: cmd+shift+c / cmd+shift+v)
	{ key = "C", mods = "CTRL|SHIFT", action = act.CopyTo("Clipboard") },
	{ key = "V", mods = "CTRL|SHIFT", action = act.PasteFrom("Clipboard") },
	-- Tabs / panes (Ghostty: cmd+t new tab, cmd+w close, cmd+shift+t new window)
	{ key = "T", mods = "CTRL|SHIFT", action = act.SpawnTab("CurrentPaneDomain") },
	{ key = "W", mods = "CTRL|SHIFT", action = act.CloseCurrentPane({ confirm = false }) },
	{ key = "N", mods = "CTRL|SHIFT", action = act.SpawnWindow },
	-- Splits (Ghostty: cmd+d right, cmd+shift+d down)
	{ key = "D", mods = "CTRL|SHIFT", action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }) },
	{ key = "E", mods = "CTRL|SHIFT", action = act.SplitVertical({ domain = "CurrentPaneDomain" }) },
	-- Navigate splits (Ghostty: cmd+[ / cmd+])
	{ key = "LeftArrow", mods = "CTRL|SHIFT", action = act.ActivatePaneDirection("Left") },
	{ key = "RightArrow", mods = "CTRL|SHIFT", action = act.ActivatePaneDirection("Right") },
	{ key = "UpArrow", mods = "CTRL|SHIFT", action = act.ActivatePaneDirection("Up") },
	{ key = "DownArrow", mods = "CTRL|SHIFT", action = act.ActivatePaneDirection("Down") },
	-- Resize splits (Ghostty: cmd+shift+[ / cmd+shift+])
	{ key = "LeftArrow", mods = "CTRL|SHIFT|ALT", action = act.AdjustPaneSize({ "Left", 10 }) },
	{ key = "RightArrow", mods = "CTRL|SHIFT|ALT", action = act.AdjustPaneSize({ "Right", 10 }) },
	{ key = "UpArrow", mods = "CTRL|SHIFT|ALT", action = act.AdjustPaneSize({ "Up", 10 }) },
	{ key = "DownArrow", mods = "CTRL|SHIFT|ALT", action = act.AdjustPaneSize({ "Down", 10 }) },
}

return config
