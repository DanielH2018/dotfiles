return {
	{
		"nvim-treesitter/nvim-treesitter",
		branch = "master",
		build = ":TSUpdate",
		config = function()
			require("nvim-treesitter.configs").setup({
				-- Parsers are cloned from GitHub and compiled with the system C toolchain.
				-- auto_install did that for whatever filetype a buffer happened to be, so
				-- opening one unfamiliar file fetched and built code unprompted. Install the
				-- languages this config actually supports instead -- conform's
				-- formatters_by_ft set, the mason LSP servers, java via ftplugin, sql via
				-- tools/sql-runner -- and nothing else. `:TSInstall <lang>` still works when
				-- a new language is wanted; it just has to be asked for.
				auto_install = false,
				ensure_installed = {
					"bash",
					"hcl",
					"java",
					"javascript",
					"json",
					"jsonc",
					"lua",
					"markdown",
					"markdown_inline",
					"python",
					"query",
					"sql",
					"terraform",
					"toml",
					"tsx",
					"typescript",
					"vim",
					"vimdoc",
					"yaml",
				},
				highlight = { enable = true },
				indent = { enable = true },
			})
		end,
	},
}
