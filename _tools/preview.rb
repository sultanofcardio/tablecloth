# Renders the site without Jekyll: kramdown for the pages, a few string substitutions for the layout.
require "kramdown"; require "kramdown-parser-gfm"; require "fileutils"
root = File.expand_path("..", __dir__); out = File.join(root, "_preview"); FileUtils.mkdir_p(File.join(out, "assets"))
FileUtils.cp_r(File.join(root, "assets"), out)
layout = File.read(File.join(root, "_layouts/default.html"))
Dir.glob(File.join(root, "*.{md,html}")).each do |f|
  next if File.basename(f) == "README.md"
  src = File.read(f); fm, body = src.split(/^---\n/, 3)[1..2]
  title = fm[/^title: (.*)$/, 1]; url = fm[/^permalink: (.*)$/, 1] || "/" + File.basename(f).sub(/\.md$/, ".html")
  html = f.end_with?(".md") ? Kramdown::Document.new(body, input: "GFM", hard_wrap: false, smart_quotes: %w[apos apos quot quot]).to_html : body
  page = layout.gsub("{{ content }}", html).gsub("{{ page.title }}", title).gsub("{{ site.baseurl }}", ".")
  page = page.gsub(/\{% if page\.url == "([^"]+)" %\}(.*?)\{% else %\}(.*?)\{% endif %\}/) { $1 == url ? $2 : $3 }
  page = page.gsub(/\{% if page\.url == "([^"]+)" %\}(.*?)\{% endif %\}/) { $1 == url ? $2 : "" }
  File.write(File.join(out, url == "/" ? "index.html" : File.basename(url)), page)
end
puts "rendered to #{out}"
