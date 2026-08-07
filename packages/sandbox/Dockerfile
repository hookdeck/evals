# Base image for the agent's sandbox. Carries the general developer tooling
# every agent run needs, plus the Hookdeck CLI (which is goal-implied tooling
# for local-dev scenarios like BM6, and how the agent authenticates a run).
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git docker.io \
  && rm -rf /var/lib/apt/lists/*

# Global npm installs (both the baked-in skills CLI below and the agent's own
# `npm install -g supabase` at setup time) land in a node-owned prefix instead
# of /usr/local, so they work without root/sudo — matching a typical user's
# machine, where global npm installs "just work" unelevated.
USER node
RUN mkdir -p /home/node/.npm-global
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global

# Vercel's agent-skills CLI, used to install agent skills from local sources
# into each session's workspace (both modes). Baked in (pinned) so installs are
# offline and instant rather than an npx download per session.
ARG SKILLS_CLI_VERSION
RUN npm install -g "skills@${SKILLS_CLI_VERSION}"

# Hookdeck CLI, pinned so runs stay comparable across the benchmark. Baked in
# rather than installed per session: `hookdeck listen` is the user's goal in
# local-dev scenarios, so the agent should find the CLI present the way a
# developer following our install docs would.
ARG HOOKDECK_CLI_VERSION
RUN npm install -g "hookdeck-cli@${HOOKDECK_CLI_VERSION}"
