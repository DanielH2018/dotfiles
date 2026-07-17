return {
	{
		"saghen/blink.cmp",
		version = "*", -- latest release tag ships the prebuilt fuzzy binary (no cargo build)
		event = "InsertEnter",
		opts = {
			keymap = { preset = "default" },
			appearance = { nerd_font_variant = "mono" },
			sources = { default = { "lsp", "path", "snippets", "buffer" } },
			completion = { documentation = { auto_show = true } },
			signature = { enabled = true },
		},
		opts_extend = { "sources.default" },
	},
}
