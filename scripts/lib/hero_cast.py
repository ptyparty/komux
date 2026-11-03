import os
import shutil
import sys

import hero_sandbox as hs

ROOT = '/tmp/demo'
SESSION = 'hero'
COLS, ROWS = 160, 48
DOWN, ALT_C, ALT_P, ALT_J, CTRL_S, ESC = '\x1b[B', '\x1bc', '\x1bp', '\x1bj', '\x13', '\x1b'

PROMPT = (
    "A 15% coupon on a $19.99 cart charges fractional cents. Fix the rounding in "
    "coupons.ts with a test, and keep a short plan in the notebook as you go. "
    "Ask me how to round before you change anything."
)

KOMUX_CONFIG = '''export default {
  defaultCwd: %(project)s,
  env: {
    QUOLL_DIR: %(notebooks)s,
    QUOLL_COMMENT_COMMAND: "komux claude compose --from-stdin --label",
  },
  untrackedCommands: ["claude", "remax", "hx", "komux", "quoll"],
  tabs: { "checkout-service": { cwd: %(project)s, layout: "ide" } },
  startup: ["checkout-service"],
  layouts: {
    ide: {
      jobs: [{ name: "claude", command: ["komux", "claude", "--mode", "auto"], dock: true }],
      row: [
        { command: ["quoll", "--focus"] },
        { command: ["remax"], focus: true },
      ],
    },
  },
};
'''


def prepare(repo):
    shutil.rmtree(ROOT, ignore_errors=True)
    ptyparty = hs.ptyparty_dir(repo)
    sandbox, env = hs.environment(ROOT, ptyparty)
    project = hs.project_from_fixture(
        os.path.join(repo, 'scripts', 'hero-fixture', 'checkout-service'),
        os.path.join(ROOT, 'checkout-service'),
    )
    notebooks = os.path.join(ROOT, 'notebooks')
    os.makedirs(notebooks)
    remax_config = os.path.join(env['XDG_CONFIG_HOME'], 'remax')
    os.makedirs(remax_config)
    with open(os.path.join(remax_config, 'config.toml'), 'w') as handle:
        handle.write('tray = 0\n')
    hs.write_komux_config(env, KOMUX_CONFIG, project=project, notebooks=notebooks)
    hs.claude_config(
        sandbox,
        project,
        [os.path.join(ptyparty, 'quoll', 'skills', 'quoll'), os.path.join(ptyparty, 'remax', 'skills', 'remax-review')],
        env,
    )
    return project, env


def tour(cast):
    cast.wait_for('not started', budget=40)
    cast.hold(1.5)
    cast.press(ALT_C, gap=0.3)
    cast.wait_for('Message claude', budget=20, record=True)
    cast.hold(0.6)
    cast.keys(PROMPT, per_key=0.005)
    cast.hold(0.8)
    cast.press('\r', gap=1.0)
    if not cast.lapse_until(lambda t: 'Claude asks' in t, budget=300):
        return False
    cast.hold(2.5)
    cast.press(DOWN, gap=1.2)
    cast.press(CTRL_S, gap=1.5)
    if not cast.lapse_until(lambda t: '🚀' in hs.dock(t), budget=600):
        return False
    cast.hold(4)
    cast.press(ALT_P, gap=5)
    cast.press(ESC, gap=1.5)
    cast.press(ALT_J, gap=6)
    cast.press(ALT_J, gap=2)
    return True


def main():
    out_base = sys.argv[1]
    repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    project, env = prepare(repo)
    hs.record(['komux', 'attach', SESSION], COLS, ROWS, project, env, SESSION, tour, out_base)


if __name__ == '__main__':
    main()
