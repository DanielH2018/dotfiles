-- Plugin wiring. Plugins are vendored via `ya pkg install` (package.toml).

require("git"):setup {
	order = 1500,
}

require("full-border"):setup {
	type = ui.Border.ROUNDED,
}

-- zoxide: feed yazi's navigation back into the shared zoxide DB.
require("zoxide"):setup {
	update_db = true,
}

-- starship: render the starship prompt as yazi's header (matches the shell).
require("starship"):setup()

-- bookmarks (dedukun): vi-style marks, persisted across sessions via yazi's DDS.
require("bookmarks"):setup {
	last_directory = { enable = true, persist = true },
	persist = "all",
	show_keys = true,
	notify = { enable = true, timeout = 1 },
}

-- smart-enter uses its default (--hovered) behavior; it's bound in keymap.toml
-- and needs no setup() unless open_multi is wanted.
