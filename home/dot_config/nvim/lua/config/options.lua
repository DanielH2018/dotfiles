-- Editor options. Leader is set here, before lazy loads, so plugin `keys` specs
-- resolve <leader> correctly.
vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.mouse = "a"

-- QoL
vim.opt.clipboard = "unnamedplus" -- share the macOS system clipboard
vim.opt.ignorecase = true
vim.opt.smartcase = true          -- case-sensitive only when the query has caps
vim.opt.undofile = true           -- persist undo history across sessions
vim.opt.scrolloff = 5             -- keep context above/below the cursor
vim.opt.signcolumn = "yes"        -- reserve the sign column so text doesn't jump
vim.opt.cursorline = true         -- highlight the line the cursor is on
vim.opt.confirm = true            -- prompt to save on :q instead of erroring

-- Windows: launching nvim from Git Bash leaks $SHELL=bash into nvim, so plugin
-- shell-outs that emit cmd.exe syntax (nvim-treesitter's :TSUpdate, mason
-- installers) get run through bash and fail (`/s: No such file`). Force nvim's
-- native cmd.exe shell + quoting so those commands run correctly.
if vim.fn.has("win32") == 1 then
	vim.opt.shell = "cmd.exe"
	vim.opt.shellcmdflag = "/s /c"
	vim.opt.shellquote = ""
	vim.opt.shellxquote = '"'
end
