# Base image for the agent's sandbox. Carries the general developer tooling
# every agent run needs, plus the Hookdeck CLI (which is goal-implied tooling
# for local-dev scenarios like BM6, and how the agent authenticates a run).
FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git docker.io \
  && rm -rf /var/lib/apt/lists/*

# Global npm installs (both the baked-in CLIs below and anything the agent
# installs with `npm install -g`) land in a node-owned prefix instead of
# /usr/local, so they work without root/sudo — matching a typical user's
# machine, where global npm installs "just work" unelevated.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global

# That prefix has to be on PATH in every shell an agent can start, and there
# are two kinds. A non-login shell (`bash -c`, which Claude Code and the
# harness use) inherits PATH from the environment, so the ENV below covers it.
# A login shell (`bash -lc`, which is how Codex runs every command) does not:
# Debian's /etc/profile overwrites PATH with a fixed list that has no npm
# prefix in it, so the pinned `hookdeck` was `command not found` on every Codex
# arm (found in run 42044644850; `toolchain-check.ts` now refuses to start a
# cell without it). /etc/profile then sources /etc/profile.d/*.sh, which is
# where the prefix is put back.
#
# A profile.d entry rather than symlinks into /usr/local/bin, because it covers
# the whole prefix: `skills`, and anything the agent itself installs globally
# mid-run, which a symlink made at build time cannot know about.
ENV PATH=/home/node/.npm-global/bin:$PATH
RUN printf '%s\n' \
      '# hookdeck-evals sandbox: /etc/profile resets PATH; put the npm prefix back.' \
      'case ":${PATH}:" in' \
      '  *:/home/node/.npm-global/bin:*) ;;' \
      '  *) PATH="/home/node/.npm-global/bin:${PATH}"; export PATH ;;' \
      'esac' \
      > /etc/profile.d/npm-global.sh \
  && chmod 0644 /etc/profile.d/npm-global.sh

USER node
RUN mkdir -p /home/node/.npm-global

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
