return {
	{
		"neovim/nvim-lspconfig",
		event = { "BufReadPre", "BufNewFile" },
		dependencies = {
			{ "mason-org/mason.nvim", opts = {} },
			"mason-org/mason-lspconfig.nvim",
			"WhoIsSethDaniel/mason-tool-installer.nvim",
		},
		config = function()
			-- Hybrid provenance: leaf servers + formatters + debug adapter via mason;
			-- node-based servers come from the system (fnm Node), jdtls runs on the
			-- sdkman JDK (see ftplugin/java.lua).
			require("mason-tool-installer").setup({
				ensure_installed = {
					"lua-language-server",
					"basedpyright",
					"ruff",
					"terraform-ls",
					"marksman",
					"jdtls",
					"stylua",
					"shfmt",
					"prettier",
					"debugpy",
				},
				run_on_start = true,
			})

			-- Completion capabilities from blink (guarded so lsp still loads without it).
			local caps = vim.lsp.protocol.make_client_capabilities()
			local ok, blink = pcall(require, "blink.cmp")
			if ok then
				caps = blink.get_lsp_capabilities(caps)
			end
			vim.lsp.config("*", { capabilities = caps })

			-- Per-server settings (merged onto nvim-lspconfig's shipped configs).
			vim.lsp.config("lua_ls", {
				settings = { Lua = { diagnostics = { globals = { "vim" } } } },
			})
			vim.lsp.config("basedpyright", {
				settings = { basedpyright = { analysis = { typeCheckingMode = "standard" } } },
			})

			-- Auto-enable mason-installed servers, except jdtls (nvim-jdtls drives it
			-- via ftplugin/java.lua so it launches on the sdkman JDK).
			require("mason-lspconfig").setup({
				automatic_enable = { exclude = { "jdtls" } },
			})

			-- System-managed node servers (on PATH via fnm) — enable explicitly since
			-- mason doesn't track them.
			vim.lsp.enable({ "vtsls", "bashls", "yamlls", "jsonls" })

			vim.diagnostic.config({
				severity_sort = true,
				virtual_text = { spacing = 2 },
				float = { border = "rounded" },
			})

			-- Buffer-local maps; K/grn/gra/grr/gri are nvim 0.11 defaults.
			vim.api.nvim_create_autocmd("LspAttach", {
				callback = function(ev)
					local function m(lhs, rhs, desc)
						vim.keymap.set("n", lhs, rhs, { buffer = ev.buf, desc = desc })
					end
					m("gd", vim.lsp.buf.definition, "Go to definition")
					m("<leader>e", vim.diagnostic.open_float, "Line diagnostics")
					m("[d", function()
						vim.diagnostic.jump({ count = -1, float = true })
					end, "Prev diagnostic")
					m("]d", function()
						vim.diagnostic.jump({ count = 1, float = true })
					end, "Next diagnostic")
				end,
			})
		end,
	},

	-- Java: jdtls is driven by ftplugin/java.lua (start_or_attach), not vim.lsp.enable.
	{ "mfussenegger/nvim-jdtls", ft = "java" },
}
