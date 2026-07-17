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
