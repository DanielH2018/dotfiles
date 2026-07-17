return {
	{
		"mfussenegger/nvim-dap",
		dependencies = {
			{ "rcarriga/nvim-dap-ui", dependencies = { "nvim-neotest/nvim-nio" } },
			"theHamsta/nvim-dap-virtual-text",
			"mfussenegger/nvim-dap-python",
		},
		keys = {
			{ "<leader>db", function() require("dap").toggle_breakpoint() end, desc = "Toggle breakpoint" },
			{ "<leader>dc", function() require("dap").continue() end, desc = "Continue" },
			{ "<leader>ds", function() require("dap").step_over() end, desc = "Step over" },
			{ "<leader>di", function() require("dap").step_into() end, desc = "Step into" },
			{ "<leader>do", function() require("dap").step_out() end, desc = "Step out" },
			{ "<leader>du", function() require("dapui").toggle() end, desc = "Toggle DAP UI" },
		},
		config = function()
			local dap, dapui = require("dap"), require("dapui")
			dapui.setup()
			require("nvim-dap-virtual-text").setup()

			-- Python debugging via debugpy (mason).
			local debugpy = vim.fn.stdpath("data") .. "/mason/packages/debugpy/venv/bin/python"
			if vim.uv.fs_stat(debugpy) then
				require("dap-python").setup(debugpy)
			end

			-- Auto open/close the DAP UI around sessions.
			dap.listeners.before.attach.dapui_config = function() dapui.open() end
			dap.listeners.before.launch.dapui_config = function() dapui.open() end
			dap.listeners.before.event_terminated.dapui_config = function() dapui.close() end
			dap.listeners.before.event_exited.dapui_config = function() dapui.close() end
		end,
	},
}
