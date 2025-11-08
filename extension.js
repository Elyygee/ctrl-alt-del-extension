const { GObject, St, Clutter, GLib, Gio } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;

if (typeof Clutter.Actor.prototype.get_visible !== 'function') {
    Clutter.Actor.prototype.get_visible = function () {
        return !!this.visible;
    };
}

let _ctrlAltDelDialog = null; 
let _triggerFile = null;
let _blackOverlays = [];
let _isLocking = false;
let _isOpeningOrClosing = false;
let _lastToggleTime = 0;
let _pollingId = null;
let _testCommandFile = null;
let _testLogFile = null;

const TEST_LOG_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.ctrl-alt-del-test-log']);
const TEST_COMMAND_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.ctrl-alt-del-command.json']);

function _appendTestLog(message) {
    try {
        if (!_testLogFile) {
            _testLogFile = Gio.File.new_for_path(TEST_LOG_PATH);
        }

        let timestamp = new Date().toISOString();
        let line = `${timestamp} ${message}\n`;
        let stream = null;
        if (_testLogFile.query_exists(null)) {
            stream = _testLogFile.append_to(Gio.FileCreateFlags.NONE, null);
        } else {
            stream = _testLogFile.create(Gio.FileCreateFlags.NONE, null);
        }
        try {
            stream.write_all(ByteArray.fromString(line), null);
        } finally {
            stream.close(null);
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Failed to append test log: ' + e);
    }
}

function _clearTestLog() {
    try {
        if (!_testLogFile) {
            _testLogFile = Gio.File.new_for_path(TEST_LOG_PATH);
        }
        if (_testLogFile.query_exists(null)) {
            _testLogFile.delete(null);
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Failed to clear test log: ' + e);
    }
}

// Check if there are multiple users on the system
function _hasMultipleUsers() {
    try {
        let [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync('loginctl list-users --no-legend');
        if (success && exitCode === 0) {
            let output = stdout.toString();
            let lines = output.split('\n').filter(line => line.trim().length > 0);
            return lines.length > 1;
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: loginctl check failed: ' + e);
    }
    return false;
}

// Create black overlays for all monitors
function _createBlackOverlays(parentGroup) {
    _removeBlackOverlays();
    const display = global.display;
    const nMonitors = display.get_n_monitors();
    const target = parentGroup || Main.uiGroup;
    
    for (let i = 0; i < nMonitors; i++) {
        const g = display.get_monitor_geometry(i);
        const overlay = new St.Widget({
            style_class: 'ctrl-alt-del-black-overlay',
            x: g.x,
            y: g.y,
            width: g.width,
            height: g.height,
            reactive: false
        });
        
        // Keep a solid black fill regardless of CSS
        overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
        target.add_child(overlay);
        overlay.set_opacity(255);
        overlay.show();
        _blackOverlays.push(overlay);
    }
}

function _removeBlackOverlays() {
    let overlaysToRemove = _blackOverlays.slice();
    _blackOverlays = [];
    
    for (let overlay of overlaysToRemove) {
        try {
            if (overlay) {
                overlay.hide();
                if (overlay.get_parent()) {
                    overlay.get_parent().remove_child(overlay);
                }
                overlay.destroy();
            }
        } catch (e) {
            global.log('Ctrl+Alt+Del: Error removing overlay: ' + e);
        }
    }
}

// Lock screen using the safest available method
function _lockScreen() {
    try {
        if (Main.screenShield && typeof Main.screenShield.lock === 'function') {
            Main.screenShield.lock();
            return;
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Main.screenShield.lock() failed: ' + e);
    }
    
    // Fallback methods
    try {
        GLib.spawn_command_line_async('dbus-send --session --type=method_call --dest=org.gnome.ScreenSaver /org/gnome/ScreenSaver org.gnome.ScreenSaver.Lock');
    } catch (e) {
        global.log('Ctrl+Alt+Del: D-Bus lock failed: ' + e);
    }
}

// Dialog class
const CtrlAltDelDialog = GObject.registerClass({
    GTypeName: 'CtrlAltDelDialogV2',
},
class CtrlAltDelDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({
            styleClass: 'ctrl-alt-del-dialog',
            destroyOnClose: true,
            shellReactive: true,
            shouldFadeIn: false,
            shouldFadeOut: false,
        });

        this.actor.layout_manager = new Clutter.BinLayout();
        this.actor.add_style_class_name('full-fill');

        let layoutRoot = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        layoutRoot.set_x_align(Clutter.ActorAlign.FILL);
        layoutRoot.set_y_align(Clutter.ActorAlign.FILL);
        // Don't let contentLayout expand - we'll set explicit size to match actor
        this.contentLayout.set_x_expand(false);
        this.contentLayout.set_y_expand(false);
        this.contentLayout.set_x_align(Clutter.ActorAlign.FILL);
        this.contentLayout.set_y_align(Clutter.ActorAlign.FILL);
        // Clip to allocation to prevent visual overflow
        this.contentLayout.set_clip_to_allocation(true);
        this.contentLayout.add_child(layoutRoot);

        let buttonCanvas = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
        });
        buttonCanvas.set_x_align(Clutter.ActorAlign.FILL);
        buttonCanvas.set_y_align(Clutter.ActorAlign.FILL);
        layoutRoot.add_child(buttonCanvas);

        let buttonContainer = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: false,
            style_class: 'ctrl-alt-del-content',
        });
        buttonContainer.set_x_align(Clutter.ActorAlign.CENTER);
        buttonContainer.set_y_align(Clutter.ActorAlign.CENTER);
        buttonCanvas.add_child(buttonContainer);
        // Position will be set in _updateAnchorPositions to center it
        this._buttonContainer = buttonContainer;

        let buttonColumn = new St.BoxLayout({
            vertical: true,
            style_class: 'ctrl-alt-del-buttons',
            x_expand: false,
            y_expand: false,
        });
        buttonColumn.set_x_align(Clutter.ActorAlign.START);
        buttonColumn.set_y_align(Clutter.ActorAlign.START);
        buttonContainer.add_child(buttonColumn);

        this._buttonList = [];
        this._anchorMargin = 16; // Reduced margin to bring power button closer to bottom-right corner
        this._usingKeyboard = false; // Track if user is navigating with keyboard
        this._dialogId = GLib.uuid_string_random();

        const logDialog = (message) => {
            _appendTestLog(`[dialog ${this._dialogId}] ${message}`);
        };
        this._logDialog = logDialog;

        const makeBtn = (label, cb, style = 'ctrl-alt-del-button') => {
            let isCancel = style.includes('cancel-button');
            let b = new St.Button({ 
                label, 
                style_class: style,
                can_focus: true,
                reactive: true,
                x_align: isCancel ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START
            });
            
            // Ensure label inside button is aligned (center for Cancel, left for others)
            let labelChild = b.get_child();
            if (labelChild && labelChild.set_x_align) {
                labelChild.set_x_align(isCancel ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START);
            }
            
            // Remove focus when clicked with mouse (not keyboard)
            b.connect('clicked', () => {
                // Only blur if this was a mouse click, not keyboard activation
                if (!this._usingKeyboard) {
                    // Remove focus from all buttons
                    if (global.stage) {
                        global.stage.set_key_focus(null);
                    }
                }
                cb();
            });
            
            b.connect('key-press-event', (actor, event) => {
                this._usingKeyboard = true; // Mark that we're using keyboard
                let key = event.get_key_symbol();
                if (key === 0xFF0D || key === 0x20) { // Enter or Space
                    cb();
                    return true;
                }
                return false;
            });
            
            // Reset keyboard flag when mouse is used
            b.connect('button-press-event', () => {
                this._usingKeyboard = false;
                return false;
            });
            
            buttonColumn.add_child(b);
            this._buttonList.push(b);
            return b;
        };

        // Lock button
        makeBtn('Lock', () => {
            _isLocking = true;
            
            if (this._keyId) {
                try {
                    this.actor.disconnect(this._keyId);
                    this._keyId = null;
                } catch (e) {}
            }
            
            this.close();
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _lockScreen();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                    _isLocking = false;
                    return false;
                });
                return false;
            });
        });

        // Switch User button (only if multiple users)
        if (_hasMultipleUsers()) {
            makeBtn('Switch User', () => {
                this.close();
                try {
                    GLib.spawn_command_line_async('gdmflexiserver');
                } catch (e) {
                    global.log('Ctrl+Alt+Del: gdmflexiserver failed: ' + e);
                }
            });
        }

        // Sign Out button
        makeBtn('Sign Out', () => {
            this.close();
            try {
                GLib.spawn_command_line_async('gnome-session-quit --logout --no-prompt');
            } catch (e) {
                global.log('Ctrl+Alt+Del: Logout failed: ' + e);
            }
        });

        // Task Manager button
        makeBtn('Task Manager', () => {
            this.close();
            try {
                GLib.spawn_command_line_async('gnome-system-monitor');
            } catch (e) {
                global.log('Ctrl+Alt+Del: System monitor failed: ' + e);
            }
        });

        // Cancel button
        makeBtn('Cancel', () => {
            this.close();
        }, 'ctrl-alt-del-button cancel-button');

        // Power menu container (hidden until power button is activated)
        let powerMenuContainer = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: false,
            style_class: 'ctrl-alt-del-power-content',
        });
        powerMenuContainer.set_x_align(Clutter.ActorAlign.START);
        powerMenuContainer.set_y_align(Clutter.ActorAlign.START);
        powerMenuContainer.hide();
        buttonCanvas.add_child(powerMenuContainer);
        this._powerMenuContainer = powerMenuContainer;
        if (typeof this._powerMenuContainer.get_visible !== 'function') {
            this._powerMenuContainer.get_visible = () => {
                return !!this._powerMenuContainer.visible;
            };
        }
        this._powerMenuAllocationId = powerMenuContainer.connect('notify::allocation', () => {
            if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                this._updatePowerMenuPosition();
            }
        });

        let powerMenuButtons = new St.BoxLayout({
            vertical: true,
            style_class: 'ctrl-alt-del-power-buttons',
            x_expand: false,
            y_expand: false,
        });
        powerMenuButtons.set_x_align(Clutter.ActorAlign.START);
        powerMenuButtons.set_y_align(Clutter.ActorAlign.START);
        powerMenuContainer.add_child(powerMenuButtons);

        // Power button box - separate from menu
        let powerBox = new St.BoxLayout({
            vertical: false, // Horizontal for just the button
            style_class: 'ctrl-alt-del-power-box',
        });
        powerBox.set_x_expand(false);
        powerBox.set_y_expand(false);
        powerBox.set_x_align(Clutter.ActorAlign.END); // Right-align
        // Add to buttonCanvas with FixedLayout - position will be set explicitly
        buttonCanvas.add_child(powerBox);
        this._powerBox = powerBox;

        let powerButton = null;
        const powerOptionButtons = [];
        this._powerOptionButtons = powerOptionButtons;

        const logPowerMenuState = (reason) => {
            let state = {
                reason,
                visible: false,
                menuPosition: null,
                menuSize: null,
                powerButtonPosition: null,
                powerButtonSize: null,
                canvasSize: null,
                optionCount: powerOptionButtons.length,
            };

            if (this._buttonCanvas) {
                let [canvasWidth, canvasHeight] = this._buttonCanvas.get_size();
                state.canvasSize = { width: canvasWidth, height: canvasHeight };
            }

            if (this._powerBox) {
                let [pbX, pbY] = this._powerBox.get_position();
                let [pbW, pbH] = this._powerBox.get_size();
                state.powerButtonPosition = { x: pbX, y: pbY };
                state.powerButtonSize = { width: pbW, height: pbH };
            }

            if (this._powerMenuContainer) {
                state.visible = !!this._powerMenuContainer.visible;
                let [menuX, menuY] = this._powerMenuContainer.get_position();
                let [menuW, menuH] = this._powerMenuContainer.get_size();
                state.menuPosition = { x: menuX, y: menuY };
                state.menuSize = { width: menuW, height: menuH };
            }

            try {
                this._logDialog(`POWER_MENU_STATE ${JSON.stringify(state)}`);
            } catch (e) {
                this._logDialog(`POWER_MENU_STATE_ERROR ${e}`);
            }
        };
        this._logPowerMenuState = logPowerMenuState;

        const hidePowerMenu = () => {
            if (!this._powerMenuContainer) {
                this._logDialog('hidePowerMenu: container missing');
                return;
            }
            if (!this._powerMenuContainer.visible) {
                this._logDialog('hidePowerMenu: already hidden');
                logPowerMenuState('hidePowerMenu-alreadyHidden');
                return;
            }
            this._powerMenuContainer.hide();
            logPowerMenuState('hidePowerMenu');
            if (powerButton) {
                powerButton.grab_key_focus();
            }
        };

        const addPowerOption = (label, command, iconName) => {
            // Create a box layout for icon and label
            let optionBox = new St.BoxLayout({
                style_class: 'ctrl-alt-del-power-option-box',
                vertical: false,
                x_expand: false,
                y_expand: false,
            });
            optionBox.set_y_align(Clutter.ActorAlign.CENTER);
            
            // Add icon
            let icon = new St.Icon({
                icon_name: iconName,
                style_class: 'ctrl-alt-del-power-option-icon',
                icon_size: 20,
            });
            icon.set_y_align(Clutter.ActorAlign.CENTER);
            optionBox.add_child(icon);
            
            // Add label
            let optionLabel = new St.Label({
                text: label,
                style_class: 'ctrl-alt-del-power-option-label',
                x_align: Clutter.ActorAlign.START,
            });
            optionLabel.set_y_align(Clutter.ActorAlign.CENTER);
            optionBox.add_child(optionLabel);
            
            // Create button with the box as content
            let option = new St.Button({
                style_class: 'ctrl-alt-del-power-option-button',
                can_focus: true,
                reactive: true,
                x_align: Clutter.ActorAlign.START,
            });
            option.set_y_align(Clutter.ActorAlign.CENTER);
            option.set_child(optionBox);

            const activate = () => {
                this._logDialog(`POWER_OPTION_ACTIVATE "${label}"`);
                hidePowerMenu();
                this.close();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    try {
                        GLib.spawn_command_line_async(command);
                        this._logDialog(`POWER_OPTION_COMMAND "${label}" executed`);
                    } catch (e) {
                        global.log(`Ctrl+Alt+Del: ${label} failed: ` + e);
                        this._logDialog(`POWER_OPTION_ERROR "${label}" ${e}`);
                    }
                    return false;
                });
            };

            option.connect('clicked', () => {
                this._logDialog(`POWER_OPTION_CLICK "${label}" mouse=${!this._usingKeyboard}`);
                if (!this._usingKeyboard) {
                    if (global.stage) {
                        global.stage.set_key_focus(null);
                    }
                }
                activate();
            });

            option.connect('button-press-event', () => {
                this._usingKeyboard = false;
                return false;
            });

            option.connect('key-press-event', (actor, event) => {
                this._usingKeyboard = true;
                let key = event.get_key_symbol();
                if (key === 0xFF0D || key === 0x20) {
                    this._logDialog(`POWER_OPTION_KEY "${label}" ENTER/SPACE`);
                    activate();
                    return true;
                }

                if (key === 0xFF1B) {
                    this._logDialog(`POWER_OPTION_KEY "${label}" ESC`);
                    hidePowerMenu();
                    return true;
                }

                if (key === 0xFF52 || key === 0xFF54) {
                    let currentIndex = powerOptionButtons.indexOf(actor);
                    if (currentIndex === -1) {
                        currentIndex = 0;
                    }
                    let newIndex;
                    if (key === 0xFF52) {
                        newIndex = currentIndex > 0 ? currentIndex - 1 : powerOptionButtons.length - 1;
                    } else {
                        newIndex = currentIndex < powerOptionButtons.length - 1 ? currentIndex + 1 : 0;
                    }
                    powerOptionButtons[newIndex].grab_key_focus();
                    return true;
                }

                if (key === 0xFF09) { // Tab
                    let currentIndex = powerOptionButtons.indexOf(actor);
                    if (currentIndex === -1) {
                        currentIndex = 0;
                    }
                    let shiftPressed = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
                    let newIndex;
                    if (shiftPressed) {
                        newIndex = currentIndex > 0 ? currentIndex - 1 : powerOptionButtons.length - 1;
                    } else {
                        newIndex = currentIndex < powerOptionButtons.length - 1 ? currentIndex + 1 : 0;
                    }
                    powerOptionButtons[newIndex].grab_key_focus();
                    return true;
                }

                return false;
            });

            powerMenuButtons.add_child(option);
            powerOptionButtons.push(option);
            logPowerMenuState(`addPowerOption-${label}`);
        };

        addPowerOption('Sleep', 'systemctl suspend', 'weather-clear-night-symbolic');
        addPowerOption('Shut Down', 'systemctl poweroff', 'system-shutdown-symbolic');
        addPowerOption('Restart', 'systemctl reboot', 'view-refresh-symbolic');

        const showPowerMenu = (initialIndex = null) => {
            this._logDialog('showPowerMenu requested');
            if (!this._powerMenuContainer) {
                this._logDialog('showPowerMenu aborted: no container');
                return;
            }
            try {
                if (this._powerMenuContainer.visible) {
                    this._logDialog('showPowerMenu: already visible');
                    logPowerMenuState('showPowerMenu-alreadyVisible');
                    return;
                }

                this._powerMenuContainer.show();
                this._powerMenuContainer.set_opacity(255);
                let parent = this._powerMenuContainer.get_parent();
                if (parent) {
                    parent.set_child_above_sibling(this._powerMenuContainer, null);
                }
                this._updatePowerMenuPosition();
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                        this._updatePowerMenuPosition();
                    }
                    return GLib.SOURCE_REMOVE;
                });
                if (Main.uiGroup) {
                    Main.uiGroup.queue_redraw();
                }
                if (typeof initialIndex === 'number' && powerOptionButtons[initialIndex]) {
                    powerOptionButtons[initialIndex].grab_key_focus();
                }
                logPowerMenuState('showPowerMenu');
            } catch (e) {
                this._logDialog(`showPowerMenu ERROR: ${e}`);
                global.log('Ctrl+Alt+Del: Error in showPowerMenu: ' + e);
            }
        };

        powerButton = new St.Button({
            style_class: 'ctrl-alt-del-power-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        let powerIcon = new St.Icon({
            icon_name: 'system-shutdown-symbolic',
            style_class: 'ctrl-alt-del-power-icon',
        });
        powerButton.set_child(powerIcon);
        powerButton.set_x_expand(false);
        powerButton.set_x_align(Clutter.ActorAlign.END); // Right-align the button
        powerBox.add_child(powerButton);
        powerBox.show();
        powerButton.show();
        this._powerButton = powerButton;
        this._buttonList.push(powerButton);
        this._buttonCanvas = buttonCanvas;
        this._positionUpdateId = null;
        this._sizeUpdateId = null;

        const togglePowerMenu = (initialIndex = null) => {
            this._logDialog('togglePowerMenu requested');
            if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                hidePowerMenu();
            } else {
                showPowerMenu(initialIndex);
            }
        };
        this._togglePowerMenu = togglePowerMenu;
        this._showPowerMenu = showPowerMenu;
        this._hidePowerMenu = hidePowerMenu;

        powerButton.connect('clicked', () => {
            let focusActor = global.stage.get_key_focus();
            let wantsFocusTransition = focusActor === powerButton;
            // Remove focus when clicked with mouse (not keyboard)
            if (!this._usingKeyboard) {
                if (global.stage) {
                    global.stage.set_key_focus(null);
                }
                // Don't set focus on first button when opened with mouse
                this._logDialog('powerButton clicked (mouse)');
                togglePowerMenu(null);
            } else {
                // Keyboard was used, so set focus on first button
                this._logDialog('powerButton clicked (keyboard)');
                togglePowerMenu(wantsFocusTransition ? 0 : null);
            }
        });
        
        // Reset keyboard flag when mouse is used on power button
        powerButton.connect('button-press-event', () => {
            this._usingKeyboard = false;
            return false;
        });

        powerButton.connect('key-press-event', (actor, event) => {
            this._usingKeyboard = true; // Mark that we're using keyboard
            let key = event.get_key_symbol();
            if (key === 0xFF0D || key === 0x20) {
                // Only Enter/Space opens the power menu - arrow keys should just navigate
                this._logDialog('powerButton key ENTER/SPACE');
                togglePowerMenu(0);
                return true;
            }

            if (key === 0xFF1B) {
                // ESC closes the power menu if it's open, otherwise let it propagate to close main dialog
                this._logDialog('powerButton key ESC');
                if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                    hidePowerMenu();
                    return true; // Consume event if menu was open
                } else {
                    return false; // Let event propagate to main dialog if menu already closed
                }
            }

            // Let arrow keys pass through to the global navigation handler
            // Don't open the power menu with arrow keys
            return false;
        });

        this._simulatePowerButtonPress = () => {
            this._logDialog('simulatePowerButtonPress invoked');
            togglePowerMenu(0);
        };

        this._updateAnchorPositions();

        // Keyboard navigation
        this._keyId = this.actor.connect('key-press-event', (actor, event) => {
            let key = event.get_key_symbol();
            let state = event.get_state();
            let hasCtrl = state & Clutter.ModifierType.CONTROL_MASK;
            let hasAlt = state & Clutter.ModifierType.MOD1_MASK;
            
            // ESC or Ctrl+Alt+Del to close
            if (key === 0xFF1B || (hasCtrl && hasAlt && (key === 0xFF08 || key === 0xFFFF || key === 0x007F))) {
                this.close();
                return true;
            }
            
            // Arrow key navigation
            if (key === 0xFF52 || key === 0xFF54) { // Up/Down
                // If power menu is open, navigate within power menu only
                if (this._powerMenuContainer && this._powerMenuContainer.visible && this._powerOptionButtons) {
                    let stage = global.stage;
                    let focusActor = stage.get_key_focus();
                    let currentIndex = -1;
                    
                    // Check if focus is on a power option button
                    for (let i = 0; i < this._powerOptionButtons.length; i++) {
                        if (this._powerOptionButtons[i] === focusActor) {
                            currentIndex = i;
                            break;
                        }
                    }
                    
                    // If no power option has focus, focus the first one
                    if (currentIndex === -1 && this._powerOptionButtons.length > 0) {
                        this._usingKeyboard = true;
                        this._powerOptionButtons[0].grab_key_focus();
                        return true;
                    }
                    
                    // If a power option has focus, let its handler deal with navigation
                    // (it already handles arrow keys, so we return false to let event propagate)
                    if (currentIndex !== -1) {
                        return false; // Let power option button handle it
                    }
                    
                    // Fallback: focus first power option
                    if (this._powerOptionButtons.length > 0) {
                        this._usingKeyboard = true;
                        this._powerOptionButtons[0].grab_key_focus();
                        return true;
                    }
                }
                
                // Power menu is closed, navigate main dialog buttons
                this._usingKeyboard = true; // Mark that we're using keyboard navigation
                let currentIndex = -1;
                let stage = global.stage;
                let focusActor = stage.get_key_focus();
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i] === focusActor) {
                        currentIndex = i;
                        break;
                    }
                }
                
                if (currentIndex === -1 && this._buttonList.length > 0) {
                    this._buttonList[0].grab_key_focus();
                    return true;
                }
                
                if (key === 0xFF52) { // Up
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : this._buttonList.length - 1;
                    this._buttonList[newIndex].grab_key_focus();
                } else { // Down
                    let newIndex = currentIndex < this._buttonList.length - 1 ? currentIndex + 1 : 0;
                    this._buttonList[newIndex].grab_key_focus();
                }
                return true;
            }
            
            // Tab navigation
            if (key === 0xFF09) { // Tab
                // If power menu is open, navigate within power menu only
                if (this._powerMenuContainer && this._powerMenuContainer.visible && this._powerOptionButtons) {
                    let stage = global.stage;
                    let focusActor = stage.get_key_focus();
                    let currentIndex = -1;
                    
                    // Check if focus is on a power option button
                    for (let i = 0; i < this._powerOptionButtons.length; i++) {
                        if (this._powerOptionButtons[i] === focusActor) {
                            currentIndex = i;
                            break;
                        }
                    }
                    
                    // If no power option has focus, focus the first one
                    if (currentIndex === -1 && this._powerOptionButtons.length > 0) {
                        this._usingKeyboard = true;
                        this._powerOptionButtons[0].grab_key_focus();
                        return true;
                    }
                    
                    // If a power option has focus, let its handler deal with navigation
                    if (currentIndex !== -1) {
                        return false; // Let power option button handle it
                    }
                    
                    // Fallback: focus first power option
                    if (this._powerOptionButtons.length > 0) {
                        this._usingKeyboard = true;
                        this._powerOptionButtons[0].grab_key_focus();
                        return true;
                    }
                }
                
                // Power menu is closed, navigate main dialog buttons
                this._usingKeyboard = true; // Mark that we're using keyboard navigation
                let currentIndex = -1;
                let stage = global.stage;
                let focusActor = stage.get_key_focus();
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i] === focusActor) {
                        currentIndex = i;
                        break;
                    }
                }
                
                if (currentIndex === -1 && this._buttonList.length > 0) {
                    this._buttonList[0].grab_key_focus();
                    return true;
                }
                
                let shiftPressed = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
                if (shiftPressed) {
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : this._buttonList.length - 1;
                    this._buttonList[newIndex].grab_key_focus();
                } else {
                    let newIndex = currentIndex < this._buttonList.length - 1 ? currentIndex + 1 : 0;
                    this._buttonList[newIndex].grab_key_focus();
                }
                return true;
            }
            
            return false;
        });
    }

    _updateAnchorPositions() {
        if (!this._powerBox) {
            return;
        }

        // Get canvas size - this should match the yellow box (contentLayout)
        let canvasWidth = 0;
        let canvasHeight = 0;
        if (this._buttonCanvas) {
            [canvasWidth, canvasHeight] = this._buttonCanvas.get_size();
        }
        
        // If canvas isn't sized yet, try using actor or contentLayout size
        if (canvasWidth <= 0 || canvasHeight <= 0) {
            if (this.contentLayout) {
                [canvasWidth, canvasHeight] = this.contentLayout.get_size();
            }
            if (canvasWidth <= 0 || canvasHeight <= 0) {
                if (this.actor) {
                    [canvasWidth, canvasHeight] = this.actor.get_size();
                }
            }
        }
        
        if (canvasWidth <= 0 || canvasHeight <= 0) {
            return;
        }

        let [powerWidth, powerHeight] = this._powerBox.get_size();
        if (powerWidth === 0 || powerHeight === 0) {
            let [, natWidth, , natHeight] = this._powerBox.get_preferred_size();
            powerWidth = natWidth;
            powerHeight = natHeight;
        }

        let margin = this._anchorMargin || 0;
        // Ensure power box stays within dialog boundaries (red box)
        // Calculate bottom-right position with margin, ensuring it's within canvas (yellow box)
        let powerX = Math.max(0, canvasWidth - powerWidth - margin);
        let powerY = Math.max(0, canvasHeight - powerHeight - margin);
        // Final clamp to ensure it never exceeds canvas boundaries
        powerX = Math.min(powerX, Math.max(0, canvasWidth - powerWidth));
        powerY = Math.min(powerY, Math.max(0, canvasHeight - powerHeight));
        
        // Ensure power button is visible
        this._powerBox.show();
        this._powerBox.set_position(powerX, powerY);
        
        // Make sure power button itself is visible
        if (this._powerButton) {
            this._powerButton.show();
        }

        // Center the green box (buttonContainer) in the middle of the screen
        if (this._buttonContainer) {
            let [containerWidth, containerHeight] = this._buttonContainer.get_size();
            if (containerWidth === 0 || containerHeight === 0) {
                let [, natWidth, , natHeight] = this._buttonContainer.get_preferred_size();
                containerWidth = natWidth;
                containerHeight = natHeight;
            }
            // Center horizontally and vertically
            let containerX = (canvasWidth - containerWidth) / 2;
            let containerY = (canvasHeight - containerHeight) / 2;
            this._buttonContainer.set_position(containerX, containerY);
        }
        
        // Update power menu position (above power button)
        this._updatePowerMenuPosition();
    }
    
    _updatePowerMenuPosition() {
        if (!this._powerMenuContainer || !this._powerBox) {
            return;
        }
        
        // Get canvas size
        let canvasWidth = 0;
        let canvasHeight = 0;
        if (this._buttonCanvas) {
            [canvasWidth, canvasHeight] = this._buttonCanvas.get_size();
        }
        if (canvasWidth <= 0 || canvasHeight <= 0) {
            return;
        }
        
        // Get power button position and size
        let [powerX, powerY] = this._powerBox.get_position();
        let [powerWidth, powerHeight] = this._powerBox.get_size();
        if (powerWidth === 0 || powerHeight === 0) {
            let [, natWidth, , natHeight] = this._powerBox.get_preferred_size();
            powerWidth = natWidth;
            powerHeight = natHeight;
        }
        
        // Get menu container size
        let [menuWidth, menuHeight] = this._powerMenuContainer.get_size();
        if (menuWidth === 0 || menuHeight === 0) {
            let [, natWidth, , natHeight] = this._powerMenuContainer.get_preferred_size();
            menuWidth = natWidth;
            menuHeight = natHeight;
        }
        
        // Position menu above the power button, right-aligned
        // Right edge of menu aligns with right edge of power button
        let menuX = powerX + powerWidth - menuWidth;
        let menuY = powerY - menuHeight - 8; // 8px gap above button
        
        // Ensure menu stays within canvas boundaries
        menuX = Math.max(0, Math.min(menuX, canvasWidth - menuWidth));
        menuY = Math.max(0, menuY); // Allow menu to go above if there's space, but not below 0
        
        this._powerMenuContainer.set_position(menuX, menuY);
        this._logPowerMenuState('updatePowerMenuPosition');
    }

    _calculateSafetyMargins(primaryGeometry) {
        // ============================================================
        // SAFETY MARGIN CONFIGURATION
        // ============================================================
        // Adjust these percentages to control how much smaller the yellow box is
        // compared to the red box (monitor size)
        // Values are in percentages (0.0 = 0%, 1.0 = 100%)
        // 
        // Example: 0.01 = 1% margin, 0.05 = 5% margin
        const SAFETY_MARGIN_LEFT_PERCENT = 0.0;    // Left margin (0% = no margin)
        const SAFETY_MARGIN_RIGHT_PERCENT = 0.0;  // Right margin (0% = no margin)
        const SAFETY_MARGIN_TOP_PERCENT = 0.0;    // Top margin (0% = no margin)
        const SAFETY_MARGIN_BOTTOM_PERCENT = 0.01; // Bottom margin (1% = makes box 1% smaller from bottom)
        // ============================================================
        
        // Calculate margins in pixels based on percentages
        let marginLeft = Math.floor(primaryGeometry.width * SAFETY_MARGIN_LEFT_PERCENT);
        let marginRight = Math.floor(primaryGeometry.width * SAFETY_MARGIN_RIGHT_PERCENT);
        let marginTop = Math.floor(primaryGeometry.height * SAFETY_MARGIN_TOP_PERCENT);
        let marginBottom = Math.floor(primaryGeometry.height * SAFETY_MARGIN_BOTTOM_PERCENT);
        
        // Calculate constrained size (monitor size minus margins)
        let constrainedWidth = Math.floor(primaryGeometry.width) - marginLeft - marginRight;
        let constrainedHeight = Math.floor(primaryGeometry.height) - marginTop - marginBottom;
        
        // Ensure valid values
        if (constrainedWidth < 1) constrainedWidth = 1;
        if (constrainedHeight < 1) constrainedHeight = 1;
        
        return { width: constrainedWidth, height: constrainedHeight };
    }

    _getMonitorForActor(actor, display) {
        // Primary method: Use the monitor containing the pointer/cursor
        // This is the most reliable method since the dialog typically opens where the user is
        let [pointerX, pointerY] = global.get_pointer();
        let numMonitors = display.get_n_monitors();
        for (let i = 0; i < numMonitors; i++) {
            let monitorGeometry = display.get_monitor_geometry(i);
            if (pointerX >= monitorGeometry.x && pointerX < monitorGeometry.x + monitorGeometry.width &&
                pointerY >= monitorGeometry.y && pointerY < monitorGeometry.y + monitorGeometry.height) {
                return { index: i, geometry: monitorGeometry };
            }
        }
        
        // Fallback: Try to use the actor's position if it's been set
        try {
            let [actorX, actorY] = actor.get_position();
            let [actorWidth, actorHeight] = actor.get_size();
            
            // Only use actor position if it's valid (not 0,0 or uninitialized)
            if (actorWidth > 0 && actorHeight > 0) {
                let centerX = actorX + (actorWidth / 2);
                let centerY = actorY + (actorHeight / 2);
                
                for (let i = 0; i < numMonitors; i++) {
                    let monitorGeometry = display.get_monitor_geometry(i);
                    if (centerX >= monitorGeometry.x && centerX < monitorGeometry.x + monitorGeometry.width &&
                        centerY >= monitorGeometry.y && centerY < monitorGeometry.y + monitorGeometry.height) {
                        return { index: i, geometry: monitorGeometry };
                    }
                }
            }
        } catch (e) {
            // Actor position not available yet, continue to fallback
        }
        
        // Final fallback: use primary monitor
        let primaryMonitor = display.get_primary_monitor();
        return { index: primaryMonitor, geometry: display.get_monitor_geometry(primaryMonitor) };
    }

    open() {
        let display = global.display;
        
        // First, open the dialog to get its initial position
        _createBlackOverlays(Main.uiGroup);
        // Make sure overlays sit below the modal dialog group (dialog stays on top)
        try {
            const modalGroup = (Main.layoutManager && Main.layoutManager.modalDialogGroup) || this.actor.get_parent();
            if (modalGroup) {
                for (let overlay of _blackOverlays) {
                    if (overlay && overlay.get_parent() === Main.uiGroup) {
                        Main.uiGroup.set_child_below_sibling(overlay, modalGroup);
                    }
                }
            }
        } catch (e) {
            global.log('Ctrl+Alt+Del: z-order tweak failed: ' + e);
        }
        Main.uiGroup.queue_redraw();
        
        super.open();
        
        // Detect which monitor the dialog is actually on (not just the primary monitor)
        // This is critical for multi-monitor setups where the dialog might open on a different monitor
        let monitorInfo = this._getMonitorForActor(this.actor, display);
        let monitorGeometry = monitorInfo.geometry;
        
        // Store the monitor geometry for the polling loop to use
        this._currentMonitorGeometry = monitorGeometry;
        
        // Ensure dialog fills entire screen border-to-border of the detected monitor
        this.actor.set_size(monitorGeometry.width, monitorGeometry.height);
        this.actor.set_position(monitorGeometry.x, monitorGeometry.y);
        this.actor.set_x_expand(true);
        this.actor.set_y_expand(true);
        this.actor.set_x_align(Clutter.ActorAlign.FILL);
        this.actor.set_y_align(Clutter.ActorAlign.FILL);
        // Remove any margins to ensure edge-to-edge coverage
        this.actor.set_margin_left(0);
        this.actor.set_margin_right(0);
        this.actor.set_margin_top(0);
        this.actor.set_margin_bottom(0);
        
        // Make yellow box (contentLayout) exactly the same size as red box (actor), positioned inside at (0,0)
        // Use the helper function to calculate size with percentage-based safety margins
        // Use the DETECTED monitor geometry, not the primary monitor
        let margins = this._calculateSafetyMargins(monitorGeometry);
        let targetWidth = margins.width;
        let targetHeight = margins.height;
        
        if (this.contentLayout) {
            // Yellow box = same size as red box, positioned at (0,0) inside red box
            // Use the smaller of actor size or primaryGeometry to ensure it never exceeds
            this.contentLayout.set_size(targetWidth, targetHeight);
            this.contentLayout.set_position(0, 0);
            this.contentLayout.set_x_expand(false);
            this.contentLayout.set_y_expand(false);
            this.contentLayout.set_margin_left(0);
            this.contentLayout.set_margin_right(0);
            this.contentLayout.set_margin_top(0);
            this.contentLayout.set_margin_bottom(0);
            // Clip to allocation to prevent visual overflow
            this.contentLayout.set_clip_to_allocation(true);
            
            // buttonCanvas should also match (with same safety margin)
            if (this._buttonCanvas) {
                this._buttonCanvas.set_size(targetWidth, targetHeight);
                this._buttonCanvas.set_x_expand(false);
                this._buttonCanvas.set_y_expand(false);
                this._buttonCanvas.set_margin_left(0);
                this._buttonCanvas.set_margin_right(0);
                this._buttonCanvas.set_margin_top(0);
                this._buttonCanvas.set_margin_bottom(0);
            }
        }
        
        // Aggressively poll to keep yellow box exactly matching red box size
        // ModalDialog might try to resize contentLayout, so we need to constantly enforce the constraint
        let sizeUpdateCount = 0;
        const maxSizeUpdates = 50;
        this._sizeUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
            sizeUpdateCount++;
            if (this.contentLayout && this.actor) {
                // Get actor's actual allocation (the space it actually occupies)
                let actorBox = this.actor.get_allocation_box();
                let actorAllocWidth = actorBox.x2 - actorBox.x1;
                let actorAllocHeight = actorBox.y2 - actorBox.y1;
                
                // Also get set size as fallback
                let [actorWidth, actorHeight] = this.actor.get_size();
                
                // CRITICAL FIX: Calculate constraint ONCE based on FIXED monitor size
                // Never recalculate it - this prevents feedback loops where:
                // 1. contentLayout shrinks
                // 2. Actor shrinks (because contentLayout is its child)
                // 3. Constraint recalculates based on smaller actor
                // 4. Constraint becomes smaller
                // 5. contentLayout shrinks more
                // 6. Loop continues until it disappears
                
                // Get current size
                let [currentWidth, currentHeight] = this.contentLayout.get_size();
                
                // Calculate constraint ONCE on first poll, then reuse it forever
                // Base it on the FIXED monitor size (the detected monitor), not the actor's current size
                if (!this._fixedConstraintWidth || !this._fixedConstraintHeight) {
                    // Use the stored monitor geometry (the monitor the dialog is actually on)
                    let monitorGeometry = this._currentMonitorGeometry;
                    if (!monitorGeometry) {
                        // Fallback: detect monitor again if not stored
                        let display = global.display;
                        let monitorInfo = this._getMonitorForActor(this.actor, display);
                        monitorGeometry = monitorInfo.geometry;
                        this._currentMonitorGeometry = monitorGeometry;
                    }
                    // Use the helper function to calculate size with percentage-based safety margins
                    let margins = this._calculateSafetyMargins(monitorGeometry);
                    this._fixedConstraintWidth = margins.width;
                    this._fixedConstraintHeight = margins.height;
                }
                
                // Always use the fixed constraint - never recalculate
                let constrainedWidth = this._fixedConstraintWidth;
                let constrainedHeight = this._fixedConstraintHeight;
                
                if (constrainedWidth > 0 && constrainedHeight > 0) {
                    
                    // Ensure we never go below 1 pixel
                    if (constrainedWidth < 1) constrainedWidth = 1;
                    if (constrainedHeight < 1) constrainedHeight = 1;
                    
                    // Only resize if the current size is actually different from the constraint
                    // This prevents infinite feedback loops
                    // Check with a small tolerance (1px) to avoid unnecessary resizes due to rounding
                    let widthDiff = Math.abs(currentWidth - constrainedWidth);
                    let heightDiff = Math.abs(currentHeight - constrainedHeight);
                    
                    if (widthDiff > 1 || heightDiff > 1 || 
                        currentWidth > constrainedWidth || currentHeight > constrainedHeight) {
                        // Only resize if needed - prevents feedback loop
                        this.contentLayout.set_size(constrainedWidth, constrainedHeight);
                    }
                    
                    this.contentLayout.set_position(0, 0);
                    // Constantly disable expansion - ModalDialog might re-enable it
                    this.contentLayout.set_x_expand(false);
                    this.contentLayout.set_y_expand(false);
                    this.contentLayout.set_margin_left(0);
                    this.contentLayout.set_margin_right(0);
                    this.contentLayout.set_margin_top(0);
                    this.contentLayout.set_margin_bottom(0);
                    // Ensure clipping is enabled to prevent visual overflow
                    this.contentLayout.set_clip_to_allocation(true);
                    
                    // buttonCanvas must also match (with same safety margin)
                    if (this._buttonCanvas) {
                        this._buttonCanvas.set_size(constrainedWidth, constrainedHeight);
                        this._buttonCanvas.set_x_expand(false);
                        this._buttonCanvas.set_y_expand(false);
                        this._buttonCanvas.set_margin_left(0);
                        this._buttonCanvas.set_margin_right(0);
                        this._buttonCanvas.set_margin_top(0);
                        this._buttonCanvas.set_margin_bottom(0);
                    }
                    
                    // Always continue polling to maintain constraint - ModalDialog might try to resize
                    // Only stop if we've verified the constraint many times
                    let [finalWidth, finalHeight] = this.contentLayout.get_size();
                    let finalBox = this.contentLayout.get_allocation_box();
                    let finalAllocHeight = finalBox.y2 - finalBox.y1;
                    
                    // Check if both size and allocation are correct
                    if (finalWidth === constrainedWidth && 
                        finalHeight === constrainedHeight &&
                        finalAllocHeight <= constrainedHeight &&
                        sizeUpdateCount >= 20) {
                        // Continue polling but less frequently to maintain constraint
                        if (sizeUpdateCount >= 40) {
                            // Keep a slower polling to maintain constraint
                            return true;
                        }
                    }
                }
            }
            
            // Never stop completely - keep polling to maintain constraint
            // But reduce frequency after initial setup
            if (sizeUpdateCount >= maxSizeUpdates) {
                // Continue with slower polling (every 50ms instead of 5ms)
                return true;
            }
            return true;
        });
        
        // Ensure power button is visible and positioned
        if (this._powerBox) {
            this._powerBox.show();
            // Raise power box above other elements to ensure it's clickable
            if (this._powerBox.get_parent()) {
                this._powerBox.get_parent().set_child_above_sibling(this._powerBox, null);
            }
        }
        if (this._powerButton) {
            this._powerButton.show();
        }
        
        // Try initial positioning immediately
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            this._updateAnchorPositions();
            return false;
        });
        
        // Poll to update anchor positions until canvas is properly sized
        let updateCount = 0;
        const maxUpdates = 20;
        this._positionUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            updateCount++;
            this._updateAnchorPositions();
            let [canvasWidth, canvasHeight] = this._buttonCanvas ? this._buttonCanvas.get_size() : [0, 0];
            if (canvasWidth > 0 && canvasHeight > 0) {
                // Canvas is sized, stop polling but do one final update
                this._updateAnchorPositions();
                this._positionUpdateId = null;
                return false;
            }
            if (updateCount >= maxUpdates) {
                // Give up after max attempts, but try one final positioning
                this._updateAnchorPositions();
                this._positionUpdateId = null;
                return false;
            }
            return true;
        });
        
        // Reset keyboard flag when dialog opens
        this._usingKeyboard = false;
        
        // Don't auto-focus first button - focus will only appear when user uses keyboard navigation
    }
    
    close() {
        if (this._overlayUpdateId) {
            GLib.source_remove(this._overlayUpdateId);
            this._overlayUpdateId = null;
        }

        if (this._positionUpdateId) {
            GLib.source_remove(this._positionUpdateId);
            this._positionUpdateId = null;
        }

        if (this._sizeUpdateId) {
            GLib.source_remove(this._sizeUpdateId);
            this._sizeUpdateId = null;
        }
        
        // Reset fixed constraint and monitor geometry so they recalculate on next open
        this._fixedConstraintWidth = null;
        this._fixedConstraintHeight = null;
        this._currentMonitorGeometry = null;

        if (this._powerMenuAllocationId && this._powerMenuContainer) {
            try {
                this._powerMenuContainer.disconnect(this._powerMenuAllocationId);
            } catch (e) {}
            this._powerMenuAllocationId = null;
        }

        if (this._powerMenuContainer) {
            this._powerMenuContainer.hide();
        }
        
        _removeBlackOverlays();
        
        if (Main.uiGroup) {
            Main.uiGroup.queue_redraw();
        }
        
        if (_ctrlAltDelDialog === this) {
            _ctrlAltDelDialog = null;
        }
        
        _isOpeningOrClosing = false;
        super.close();
    }
    
    vfunc_destroy() {
        if (this._overlayUpdateId) {
            GLib.source_remove(this._overlayUpdateId);
            this._overlayUpdateId = null;
        }

        if (this._positionUpdateId) {
            GLib.source_remove(this._positionUpdateId);
            this._positionUpdateId = null;
        }

        if (this._sizeUpdateId) {
            GLib.source_remove(this._sizeUpdateId);
            this._sizeUpdateId = null;
        }
        
        // Reset fixed constraint and monitor geometry so they recalculate on next open
        this._fixedConstraintWidth = null;
        this._fixedConstraintHeight = null;
        this._currentMonitorGeometry = null;
        
        if (this._keyId) {
            try {
                this.actor.disconnect(this._keyId);
            } catch (e) {}
            this._keyId = null;
        }

        if (this._powerMenuAllocationId && this._powerMenuContainer) {
            try {
                this._powerMenuContainer.disconnect(this._powerMenuAllocationId);
            } catch (e) {}
            this._powerMenuAllocationId = null;
        }

        if (this._powerMenuContainer) {
            this._powerMenuContainer.hide();
        }
        
        _removeBlackOverlays();
        
        if (Main.uiGroup) {
            Main.uiGroup.queue_redraw();
        }
        
        if (_ctrlAltDelDialog === this) {
            _ctrlAltDelDialog = null;
        }
        
        super.vfunc_destroy();
    }

    _disconnectAnchorSignals() {
        if (!this._anchorSignals) {
            return;
        }

        for (let entry of this._anchorSignals) {
            if (!entry || !entry.target || !entry.id) {
                continue;
            }
            try {
                entry.target.disconnect(entry.id);
            } catch (e) {}
        }
        this._anchorSignals = [];
    }
});

function init() {
    // Extension initialization
}

// Handle Ctrl+Alt+Del trigger
function _handleCtrlAltDel() {
    if (_isLocking) {
        return;
    }
    
    let currentTime = Date.now();
    if (currentTime - _lastToggleTime < 200) {
        return;
    }
    
    _lastToggleTime = currentTime;
    
    // Toggle dialog
    if (_ctrlAltDelDialog) {
        let isActuallyOpen = _ctrlAltDelDialog.actor && 
                           _ctrlAltDelDialog.actor.get_parent() !== null;
        
        if (isActuallyOpen) {
            try {
                _isOpeningOrClosing = true;
                _ctrlAltDelDialog.close();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    _isOpeningOrClosing = false;
                    return false;
                });
            } catch (e) {
                global.log('Ctrl+Alt+Del: Error closing dialog: ' + e);
                _ctrlAltDelDialog = null;
                _isOpeningOrClosing = false;
            }
            return;
        } else {
            _ctrlAltDelDialog = null;
        }
    }
    
    if (_isOpeningOrClosing) {
        return;
    }
    
    // Create and open new dialog
    _isOpeningOrClosing = true;
    try {
        _ctrlAltDelDialog = new CtrlAltDelDialog();
        _ctrlAltDelDialog.open();
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            _isOpeningOrClosing = false;
            return false;
        });
    } catch (e) {
        global.log('Ctrl+Alt+Del: Error creating/opening dialog: ' + e + (e && e.stack ? '\n' + e.stack : ''));
        _ctrlAltDelDialog = null;
        _isOpeningOrClosing = false;
    }
}

function _handleTestCommandFile() {
    if (!_testCommandFile) {
        return;
    }

    try {
        if (!_testCommandFile.query_exists(null)) {
            return;
        }

        let [, contents] = _testCommandFile.load_contents(null);
        let text = ByteArray.toString(contents);
        let payload = null;
        try {
            payload = JSON.parse(text);
        } catch (e) {
            global.log('Ctrl+Alt+Del: Failed to parse test command JSON: ' + e + ' (content: ' + text + ')');
            _appendTestLog(`CMD PARSE_ERROR ${e}`);
        }

        try {
            _testCommandFile.delete(null);
        } catch (e) {}

        if (!payload) {
            return;
        }

        _processTestCommands(payload);
    } catch (e) {
        global.log('Ctrl+Alt+Del: Error handling test command file: ' + e);
        _appendTestLog(`CMD ERROR ${e}`);
        try {
            if (_testCommandFile && _testCommandFile.query_exists(null)) {
                _testCommandFile.delete(null);
            }
        } catch (err) {}
    }
}

function _processTestCommands(payload) {
    let id = null;
    let actions = [];

    if (Array.isArray(payload)) {
        actions = payload;
    } else if (payload && Array.isArray(payload.actions)) {
        actions = payload.actions;
        id = payload.id || null;
    } else if (payload && (payload.action || payload.type)) {
        actions = [payload];
        id = payload.id || null;
    }

    if (!id) {
        id = GLib.uuid_string_random();
    }

    if (!actions || actions.length === 0) {
        _appendTestLog(`CMD ${id} NO_ACTIONS`);
        return;
    }

    try {
        global.log(`Ctrl+Alt+Del: Processing test command ${id} with ${actions.length} action(s)`);
    } catch (e) {}

    _appendTestLog(`CMD ${id} START (${actions.length} actions)`);

    for (let actionObj of actions) {
        let type = null;
        if (!actionObj) {
            continue;
        }
        type = actionObj.action || actionObj.type || null;
        if (!type) {
            _appendTestLog(`CMD ${id} ACTION UNKNOWN null`);
            continue;
        }
        let upperType = type.toUpperCase();
        try {
            switch (type) {
                case 'clearLog':
                    _clearTestLog();
                    _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                    break;
                case 'wait':
                case 'sleep':
                case 'delay': {
                    let ms = 0;
                    const candidates = [actionObj.ms, actionObj.duration, actionObj.time];
                    for (let value of candidates) {
                        if (typeof value === 'number') {
                            ms = value;
                            break;
                        } else if (typeof value === 'string') {
                            let parsed = parseFloat(value);
                            if (Number.isFinite(parsed)) {
                                ms = parsed;
                                break;
                            }
                        }
                    }
                    if (!Number.isFinite(ms) || ms < 0) {
                        ms = 0;
                    }
                    if (ms > 10000) {
                        ms = 10000;
                    }
                    let usec = Math.floor(ms * 1000);
                    if (usec > 0) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SLEEP ${ms}ms`);
                        GLib.usleep(usec);
                    }
                    _appendTestLog(`CMD ${id} ACTION ${upperType} OK ${ms}ms`);
                    break;
                }
                case 'openDialog':
                    if (_ctrlAltDelDialog && _ctrlAltDelDialog.actor && _ctrlAltDelDialog.actor.get_parent()) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP already open`);
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} EXECUTE`);
                        _handleCtrlAltDel();
                        if (_ctrlAltDelDialog) {
                            let dialogId = _ctrlAltDelDialog._dialogId || 'unknown';
                            _appendTestLog(`CMD ${id} ACTION ${upperType} DIALOG ${dialogId}`);
                        } else {
                            _appendTestLog(`CMD ${id} ACTION ${upperType} PENDING`);
                        }
                    }
                    break;
                case 'closeDialog':
                    if (_ctrlAltDelDialog) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} EXECUTE`);
                        try {
                            _ctrlAltDelDialog.close();
                            _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                        } catch (e) {
                            _appendTestLog(`CMD ${id} ACTION ${upperType} ERROR ${e}`);
                        }
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP no dialog`);
                    }
                    break;
                case 'togglePowerMenu':
                    if (_ctrlAltDelDialog && _ctrlAltDelDialog._togglePowerMenu) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} EXECUTE`);
                        try {
                            _ctrlAltDelDialog._togglePowerMenu(0);
                            _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                        } catch (e) {
                            _appendTestLog(`CMD ${id} ACTION ${upperType} ERROR ${e}`);
                            global.log('Ctrl+Alt+Del: Error toggling power menu: ' + e);
                        }
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP no dialog`);
                    }
                    break;
                case 'showPowerMenu':
                    if (_ctrlAltDelDialog && _ctrlAltDelDialog._showPowerMenu) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} EXECUTE`);
                        try {
                            _ctrlAltDelDialog._showPowerMenu(0);
                            _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                        } catch (e) {
                            _appendTestLog(`CMD ${id} ACTION ${upperType} ERROR ${e}`);
                            global.log('Ctrl+Alt+Del: Error showing power menu: ' + e);
                        }
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP no dialog`);
                    }
                    break;
                case 'hidePowerMenu':
                    if (_ctrlAltDelDialog && _ctrlAltDelDialog._hidePowerMenu) {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} EXECUTE`);
                        _ctrlAltDelDialog._hidePowerMenu();
                        _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP no dialog`);
                    }
                    break;
                case 'reportPowerMenu':
                    if (_ctrlAltDelDialog && _ctrlAltDelDialog._logPowerMenuState) {
                        let label = actionObj.label || 'reportPowerMenu';
                        _ctrlAltDelDialog._logPowerMenuState(label);
                        _appendTestLog(`CMD ${id} ACTION ${upperType} OK`);
                    } else {
                        _appendTestLog(`CMD ${id} ACTION ${upperType} SKIP no dialog`);
                    }
                    break;
                default:
                    _appendTestLog(`CMD ${id} ACTION ${upperType} UNKNOWN`);
                    break;
            }
        } catch (e) {
            _appendTestLog(`CMD ${id} ACTION ${upperType} ERROR ${e}`);
        }
    }

    _appendTestLog(`CMD ${id} COMPLETE`);
}

function enable() {
    global.log('Ctrl+Alt+Del: Extension enabled!');
    
    // Try to register global keybinding
    try {
        const Meta = imports.gi.Meta;
        let keybindingSettings = null;
        try {
            keybindingSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.ctrl-alt-del' });
        } catch (e) {
            global.log('Ctrl+Alt+Del: Schema not found, using file-based trigger');
        }
        
        if (keybindingSettings) {
            try {
                global.display.add_keybinding(
                    'ctrl-alt-del',
                    keybindingSettings,
                    Meta.KeyBindingFlags.NONE,
                    () => {
                        _handleCtrlAltDel();
                    }
                );
                global.log('Ctrl+Alt+Del: Global keybinding registered');
            } catch (e) {
                global.log('Ctrl+Alt+Del: Could not register keybinding: ' + e);
            }
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Keybinding setup failed: ' + e);
    }
    
    // Set up file-based trigger polling
    _triggerFile = Gio.file_new_for_path(GLib.get_home_dir() + '/.ctrl-alt-del-trigger');
    _testCommandFile = Gio.File.new_for_path(TEST_COMMAND_PATH);
    _clearTestLog();
    try {
        global.log(`Ctrl+Alt+Del: Test command path ${TEST_COMMAND_PATH}`);
        global.log(`Ctrl+Alt+Del: Test log path ${TEST_LOG_PATH}`);
    } catch (e) {}
    try {
        if (_testCommandFile.query_exists(null)) {
            _testCommandFile.delete(null);
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Failed to remove stale test command file: ' + e);
    }
    
    _pollingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, function() {
        try {
            if (_isLocking) {
                _handleTestCommandFile();
                return true;
            }
            
            if (_triggerFile && _triggerFile.query_exists(null)) {
                try {
                    _triggerFile.delete(null);
                } catch (e) {}
                
                _handleCtrlAltDel();
                _handleTestCommandFile();
                return true;
            }

            _handleTestCommandFile();
        } catch (e) {
            global.log('Ctrl+Alt+Del ERROR: ' + e);
        }
        return true;
    });
    
    // Note: monitors-changed signal not available in GNOME 42
    // Overlays are recreated with current geometry each time dialog opens
    // For GNOME 45+, you could use: global.display.connect('monitors-changed', ...)
}

function disable() {
    global.log('Ctrl+Alt+Del: Extension disabled!');
    
    if (_pollingId) {
        GLib.source_remove(_pollingId);
        _pollingId = null;
    }
    
    _removeBlackOverlays();
    
    if (_ctrlAltDelDialog) {
        _ctrlAltDelDialog.destroy();
        _ctrlAltDelDialog = null;
    }
    
    _triggerFile = null;
    _testCommandFile = null;
}