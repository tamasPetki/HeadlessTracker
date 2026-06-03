# Image for MCP directory indexers (e.g. Glama) to start the HeadlessTracker
# MCP server on stdio and introspect its tool list.
#
# End users do NOT need Docker. Install with `npx headless-tracker` (see README).
# Listing tools requires no credentials, so this image needs no configuration.
#
# This installs the published, Node-runnable package, which is the exact artifact
# users get. node:sqlite is built into Node, so there is no native build step and
# nothing to compile.
FROM node:22-slim

# @latest so indexer rebuilds track the newest published release.
RUN npm install -g headless-tracker@latest

# No subcommand starts the MCP server on stdio (the mode an MCP client connects to).
ENTRYPOINT ["headless-tracker"]
