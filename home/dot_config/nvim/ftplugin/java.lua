-- Starts jdtls for Java buffers (nvim-jdtls). Runs the mason-shipped jdtls
-- launcher on the sdkman-managed `java` on PATH — Java stays read/light-edit;
-- IntelliJ remains the heavy JVM tool.
local ok, jdtls = pcall(require, "jdtls")
if not ok then
	return
end

local mason = vim.fn.stdpath("data") .. "/mason/packages/jdtls"
local launcher = vim.fn.glob(mason .. "/plugins/org.eclipse.equinox.launcher_*.jar")
if launcher == "" then
	return -- jdtls not installed yet (mason will fetch it); reopen the file afterward
end

local root = vim.fs.root(0, {
	"gradlew",
	"mvnw",
	"settings.gradle",
	"settings.gradle.kts",
	"build.gradle",
	"build.gradle.kts",
	"pom.xml",
	".git",
})
local project = vim.fn.fnamemodify(root or vim.fn.getcwd(), ":p:h:t")
local workspace = vim.fn.stdpath("cache") .. "/jdtls/" .. project

local config = {
	cmd = {
		vim.fn.exepath("java"), -- sdkman-managed JDK (must be 17+)
		"-Declipse.application=org.eclipse.jdt.ls.core.id1",
		"-Dosgi.bundles.defaultStartLevel=4",
		"-Declipse.product=org.eclipse.jdt.ls.core.product",
		"-Dlog.protocol=true",
		"-Dlog.level=ALL",
		"-Xmx2g",
		"--add-modules=ALL-SYSTEM",
		"--add-opens",
		"java.base/java.util=ALL-UNNAMED",
		"--add-opens",
		"java.base/java.lang=ALL-UNNAMED",
		"-jar",
		launcher,
		"-configuration",
		mason .. "/config_mac",
		"-data",
		workspace,
	},
	root_dir = root,
	settings = { java = {} },
}

jdtls.start_or_attach(config)
