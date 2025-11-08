# Windows Ctrl+Alt+Del Screen

A GNOME Shell extension that provides a Windows-style Ctrl+Alt+Del security screen with power options.

## Features

* **Lock Screen** - Quickly lock your screen
* **Switch User** - Switch between users (if multiple users exist)
* **Sign Out** - Log out of your session
* **Task Manager** - Open GNOME System Monitor
* **Power Menu** - Access sleep, shutdown, and restart options
* **Full-Screen Dialog** - Immersive full-screen experience
* **Modern UI** - Rounded buttons with hover and click effects
* **Keyboard Navigation** - Full keyboard support with arrow keys and Tab
* **Mouse Support** - Intuitive mouse interaction

## Installation

### From extensions.gnome.org

1. Visit [extensions.gnome.org](https://extensions.gnome.org)
2. Search for "Windows Ctrl+Alt+Del Screen"
3. Click the toggle to install

### Manual Installation

1. Download the latest release ZIP file
2. Extract it to `~/.local/share/gnome-shell/extensions/`
3. Rename the folder to `ctrl-alt-del@elyygee.github.io`
4. Restart GNOME Shell (Alt+F2, type `r`, press Enter)
5. Enable the extension in GNOME Extensions app

## Usage

Press **Ctrl+Alt+Del** to open the security screen. You can:

- Use **arrow keys** or **Tab** to navigate between options
- Press **Enter** or **Space** to activate an option
- Press **Escape** or **Ctrl+Alt+Del** again to close
- Click the **power button** (bottom-right) to access power options

## Requirements

* GNOME Shell 42, 43, 44, or 45
* systemd (for power options)
* [Mission Center](https://missioncenter.io/) application (recommended for Task Manager functionality) - Available on [Flathub](https://flathub.org/apps/io.missioncenter.MissionCenter)

## Screenshots

The extension provides a full-screen black dialog with:
- Vertical list of action buttons on the left
- Power button in the bottom-right corner
- Power menu popup with sleep, shutdown, and restart options

## Keyboard Shortcuts

* **Ctrl+Alt+Del** - Open/close security screen
* **Arrow Keys** - Navigate between options
* **Tab/Shift+Tab** - Navigate between options
* **Enter/Space** - Activate selected option
* **Escape** - Close dialog

## Troubleshooting

If the extension doesn't work:

1. Make sure it's enabled in GNOME Extensions
2. Check the extension version matches your GNOME Shell version
3. Restart GNOME Shell (Alt+F2, type `r`, press Enter)
4. Check the logs: `journalctl -f | grep -i "ctrl-alt-del"`

## Development

### Building from Source

```bash
git clone https://github.com/Elyygee/ctrl-alt-del-extension.git
cd ctrl-alt-del-extension
# Copy to extensions directory
cp -r ctrl-alt-del@elyygee.github.io ~/.local/share/gnome-shell/extensions/
```

### File Structure

```
ctrl-alt-del@elyygee.github.io/
├── extension.js      # Main extension code
├── stylesheet.css    # Styles and theming
├── metadata.json     # Extension metadata
└── LICENSE           # GPL-2.0-or-later license
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This extension is licensed under the GNU General Public License v2.0 or later (GPL-2.0-or-later).

## Credits

Created by Elyygee

## Support

For issues, feature requests, or questions:
- Open an issue on [GitHub](https://github.com/Elyygee/ctrl-alt-del-extension/issues)
- Check the [extensions.gnome.org](https://extensions.gnome.org) page

