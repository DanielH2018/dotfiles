-- Plugin wiring. Plugins are vendored via `ya pkg install` (package.toml).

require("git"):setup {
	order = 1500,
}

require("full-border"):setup {
	type = ui.Border.ROUNDED,
}

-- smart-enter uses its default (--hovered) behavior; it's bound in keymap.toml
-- and needs no setup() unless open_multi is wanted.
