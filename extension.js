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

// Scaling system for different monitor resolutions
// Base resolution: 1920x1080 (Full HD)
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;


// Apply scaled CSS styles to an element
function _applyScaledStyle(element, styles) {
    if (!element || !styles) return;
    
    let css = '';
    
    for (let property in styles) {
        let value = styles[property];
        if (typeof value === 'number') {
            // Value is already scaled, just add px
            css += `${property}: ${value}px !important; `;
        } else {
            css += `${property}: ${value} !important; `;
        }
    }
    
    if (css) {
        element.set_style(css);
    }
}


// Check if there are multiple users on the system
// Uses getent passwd to check all regular users (UID >= 1000 and < 65534)
// Returns true if there are more than 1 user (>= 2), false if exactly 1 user
function _hasMultipleUsers() {
    try {
        // Use sh -c to properly handle the pipe and awk command
        let [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync('sh -c "getent passwd | awk -F: \'$3 >= 1000 && $3 < 65534 {print $1}\' | sort -u"');
        if (success && exitCode === 0 && stdout) {
            let output = stdout.toString();
            let lines = output.split('\n').filter(line => line.trim().length > 0);
            // Return true if there are more than 1 user (>= 2), false if exactly 1 user
            return lines.length > 1;
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: User detection failed: ' + e);
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
            reactive: true // Make reactive to receive click events
        });
        
        // Keep a solid black fill regardless of CSS
        overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
        
        // Add click handler to close power menu if visible
        overlay.connect('button-press-event', () => {
            if (_ctrlAltDelDialog && _ctrlAltDelDialog._powerMenuContainer && _ctrlAltDelDialog._powerMenuContainer.visible) {
                if (_ctrlAltDelDialog._hidePowerMenu) {
                    _ctrlAltDelDialog._hidePowerMenu();
                }
            }
            return false; // Don't consume event, let it propagate
        });
        
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
        this._buttonColumn = buttonColumn; // Store reference for button width calculations

        this._buttonList = [];
        // Use height-based scaling for anchor margin to prevent stretching on ultra-wide monitors
        try {
            const display = global.display;
            const primaryMonitor = display.get_primary_monitor();
            const geometry = display.get_monitor_geometry(primaryMonitor);
            const heightScale = geometry.height / BASE_HEIGHT;
            this._anchorMargin = Math.round(16 * heightScale);
        } catch (e) {
            this._anchorMargin = 16; // Fallback
        }
        this._usingKeyboard = false; // Track if user is navigating with keyboard
        this._dialogId = GLib.uuid_string_random();
        this._powerMenuWidth = null; // Store fixed width to prevent jitter
        this._powerMenuButtonsWidth = null; // Store fixed width for inner buttons container

        const makeBtn = (label, cb, style = 'ctrl-alt-del-button') => {
            let isCancel = style.includes('cancel-button');
            let b = new St.Button({ 
                label, 
                style_class: style,
                can_focus: true,
                reactive: true,
                x_align: isCancel ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
                x_expand: !isCancel, // Expand to fill container width (except Cancel)
                y_expand: false
            });
            
            // Ensure label inside button is aligned (center for Cancel, left for others)
            let labelChild = b.get_child();
            if (labelChild && labelChild.set_x_align) {
                labelChild.set_x_align(isCancel ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START);
            }
            
            // Center label vertically for Cancel button
            if (isCancel && labelChild && labelChild.set_y_align) {
                labelChild.set_y_align(Clutter.ActorAlign.CENTER);
            }
            
            // Ensure label doesn't affect button width
            if (labelChild && labelChild.set_x_expand) {
                labelChild.set_x_expand(false);
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
            
            // Special handling for switch user button - visibility is managed by _hasMultipleUsers() check
            // Don't force visibility here, let the initial check and open() method handle it
            
            // Set Cancel button width immediately after creation
            if (isCancel) {
                try {
                    const display = global.display;
                    const primaryMonitor = display.get_primary_monitor();
                    const geometry = display.get_monitor_geometry(primaryMonitor);
                    let cancelWidth = Math.round(geometry.width * 0.22); // 22% of screen width (slightly smaller)
                    // Calculate 10% margin from left and right (10% of button column width, which is 10.83% of screen)
                    let columnWidth = Math.round(geometry.width * 0.1083);
                    let leftMargin = Math.round(columnWidth * 0.10); // 10% of column width
                    let rightMargin = Math.round(columnWidth * 0.10); // 10% of column width
                    b.set_width(cancelWidth);
                    b.set_x_expand(false);
                    b.set_x_align(Clutter.ActorAlign.START); // Align to start to allow margin
                    _applyScaledStyle(b, {
                        'width': cancelWidth,
                        'min-width': cancelWidth,
                        'max-width': cancelWidth,
                        'margin-left': leftMargin,
                        'margin-right': rightMargin,
                        'flex-shrink': 0,
                        'flex-grow': 0
                    });
                } catch (e) {
                    // If geometry not available yet, will be set in _setContainerWidths
                }
            }
            
            // Force button to fill container width (except Cancel)
            if (!isCancel) {
                // Set button width to fill column (accounting for padding)
                // Column padding is 16px on each side = 32px total
                let setButtonWidth = () => {
                    try {
                        let [columnWidth] = buttonColumn.get_size();
                        if (columnWidth > 0) {
                            // Use height-based scaling for padding (consistent with _setContainerWidths)
                            const display = global.display;
                            const primaryMonitor = display.get_primary_monitor();
                            const geometry = display.get_monitor_geometry(primaryMonitor);
                            const heightScale = geometry.height / BASE_HEIGHT;
                            const totalPadding = Math.round(32 * heightScale); // 16px left + 16px right = 32px base
                            let buttonWidth = columnWidth - totalPadding;
                            b.set_width(buttonWidth);
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                };
                
                // Set width after column is sized
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    setButtonWidth();
                    return GLib.SOURCE_REMOVE;
                });
                
                // Update width when column size changes
                let allocationId = buttonColumn.connect('notify::allocation', setButtonWidth);
                if (!this._buttonAllocationIds) {
                    this._buttonAllocationIds = [];
                }
                this._buttonAllocationIds.push(allocationId);
            }
            
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

        // Switch User button (always create, but show/hide based on multiple users)
        this._switchUserButton = makeBtn('Switch User', () => {
            this.close();
            try {
                GLib.spawn_command_line_async('gdmflexiserver');
            } catch (e) {
                global.log('Ctrl+Alt+Del: gdmflexiserver failed: ' + e);
            }
        });
        
        // Initially set visibility based on multiple users (will be updated in open() if needed)
        // Always show the button initially - visibility will be managed in open()
        // This ensures the button exists and can be shown when needed
        this._switchUserButton.show();
        this._switchUserButton.visible = true;
        this._switchUserButton.set_opacity(255);
        this._switchUserButton.can_focus = true;

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
        // Don't connect allocation signal - it causes jitter
        // We'll update position manually when needed (on show, on dialog resize, etc.)
        this._powerMenuAllocationId = null;

        let powerMenuButtons = new St.BoxLayout({
            vertical: true,
            style_class: 'ctrl-alt-del-power-buttons',
            x_expand: false,
            y_expand: false,
        });
        powerMenuButtons.set_x_align(Clutter.ActorAlign.START);
        powerMenuButtons.set_y_align(Clutter.ActorAlign.START);
        powerMenuContainer.add_child(powerMenuButtons);
        this._powerMenuButtons = powerMenuButtons; // Store reference for button width calculations

        // Power button box - separate from menu
        let powerBox = new St.BoxLayout({
            vertical: false, // Horizontal for just the button
            style_class: 'ctrl-alt-del-power-box',
            reactive: false, // Don't intercept hover events - let them reach the button
        });
        powerBox.set_x_expand(false);
        powerBox.set_y_expand(false);
        powerBox.set_x_align(Clutter.ActorAlign.END); // Right-align
        
        // Set power box size to match button (square)
        // Use height-based scaling to prevent stretching on ultra-wide monitors
        let powerButtonSize = 48; // Default fallback
        try {
            const display = global.display;
            const primaryMonitor = display.get_primary_monitor();
            const geometry = display.get_monitor_geometry(primaryMonitor);
            const heightScale = geometry.height / BASE_HEIGHT;
            powerButtonSize = Math.round(48 * heightScale);
        } catch (e) {
            // Use default fallback
        }
        powerBox.set_width(powerButtonSize);
        powerBox.set_height(powerButtonSize);
        
        // Add to buttonCanvas with FixedLayout - position will be set explicitly
        buttonCanvas.add_child(powerBox);
        this._powerBox = powerBox;

        let powerButton = null;
        const powerOptionButtons = [];
        this._powerOptionButtons = powerOptionButtons;


        const hidePowerMenu = () => {
            if (!this._powerMenuContainer) {
                return;
            }
            if (!this._powerMenuContainer.visible) {
                return;
            }
            this._powerMenuContainer.hide();
            // Only grab focus on power button if keyboard was used
            // If mouse was used, clear focus to remove white border
            if (powerButton) {
                if (this._usingKeyboard) {
                    powerButton.grab_key_focus();
                } else {
                    // Clear focus when menu closes if mouse was used
                    if (global.stage) {
                        global.stage.set_key_focus(null);
                    }
                }
                // Restore hover state if mouse is still over button
                if (isHovering) {
                    applyHoverStyle();
                }
            }
        };

        const addPowerOption = (label, command, iconName) => {
            // Create a box layout for icon and label
            // Use x_expand: true to fill button width and prevent jitter
            let optionBox = new St.BoxLayout({
                style_class: 'ctrl-alt-del-power-option-box',
                vertical: false,
                x_expand: true, // Expand to fill button width to prevent jitter
                y_expand: false,
            });
            optionBox.set_y_align(Clutter.ActorAlign.CENTER);
            optionBox.set_x_align(Clutter.ActorAlign.START);
            
            // Add icon - use height-based scaling to prevent stretching on ultra-wide monitors
            let iconSize = 20; // Base size
            try {
                const display = global.display;
                const primaryMonitor = display.get_primary_monitor();
                const geometry = display.get_monitor_geometry(primaryMonitor);
                const heightScale = geometry.height / BASE_HEIGHT;
                iconSize = Math.round(20 * heightScale);
            } catch (e) {
                // Use base size if calculation fails
            }
            let icon = new St.Icon({
                icon_name: iconName,
                style_class: 'ctrl-alt-del-power-option-icon',
                icon_size: iconSize,
            });
            icon.set_y_align(Clutter.ActorAlign.CENTER);
            icon.set_x_expand(false); // Don't expand icon
            icon.set_x_align(Clutter.ActorAlign.START);
            optionBox.add_child(icon);
            
            // Add label - expand to fill remaining space
            let optionLabel = new St.Label({
                text: label,
                style_class: 'ctrl-alt-del-power-option-label',
                x_align: Clutter.ActorAlign.START,
            });
            optionLabel.set_y_align(Clutter.ActorAlign.CENTER);
            optionLabel.set_x_expand(true); // Expand to fill remaining space
            optionLabel.set_x_align(Clutter.ActorAlign.START);
            optionBox.add_child(optionLabel);
            
            // Create button with the box as content
            let option = new St.Button({
                style_class: 'ctrl-alt-del-power-option-button',
                can_focus: true,
                reactive: true,
                x_align: Clutter.ActorAlign.START,
                x_expand: true, // Expand to fill container width
                y_expand: false
            });
            option.set_y_align(Clutter.ActorAlign.CENTER);
            option.set_child(optionBox);

            const activate = () => {
                hidePowerMenu();
                this.close();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    try {
                        GLib.spawn_command_line_async(command);
                    } catch (e) {
                        global.log(`Ctrl+Alt+Del: ${label} failed: ` + e);
                    }
                    return false;
                });
            };

            option.connect('clicked', () => {
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
                    activate();
                    return true;
                }

                if (key === 0xFF1B) {
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
            
            // Force button to fill container width
            // Set button width to fill container (accounting for padding)
            // Container padding is 8px on each side = 16px total
            let setPowerButtonWidth = () => {
                try {
                    let [containerWidth] = powerMenuButtons.get_size();
                    if (containerWidth > 0) {
                        // Use height-based scaling for padding (consistent with _setContainerWidths)
                        const display = global.display;
                        const primaryMonitor = display.get_primary_monitor();
                        const geometry = display.get_monitor_geometry(primaryMonitor);
                        const heightScale = geometry.height / BASE_HEIGHT;
                        const totalPadding = Math.round(16 * heightScale); // 8px left + 8px right = 16px base
                        let buttonWidth = containerWidth - totalPadding;
                        option.set_width(buttonWidth);
                    }
                } catch (e) {
                    // Ignore errors
                }
            };
            
            // Set width after container is sized
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                setPowerButtonWidth();
                return GLib.SOURCE_REMOVE;
            });
            
            // Update width when container size changes
            let allocationId = powerMenuButtons.connect('notify::allocation', setPowerButtonWidth);
            if (!this._powerButtonAllocationIds) {
                this._powerButtonAllocationIds = [];
            }
            this._powerButtonAllocationIds.push(allocationId);
            
        };

        addPowerOption('Sleep', 'systemctl suspend', 'weather-clear-night-symbolic');
        addPowerOption('Shut Down', 'systemctl poweroff', 'system-shutdown-symbolic');
        addPowerOption('Restart', 'systemctl reboot', 'view-refresh-symbolic');

        const showPowerMenu = (initialIndex = null) => {
            if (!this._powerMenuContainer) {
                return;
            }
            try {
                if (this._powerMenuContainer.visible) {
                    return;
                }

                // Ensure width is set before showing to prevent jitter
                try {
                    let menuWidth = this._powerMenuWidth;
                    if (!menuWidth) {
                        // Calculate if not stored yet
                        const display = global.display;
                        const primaryMonitor = display.get_primary_monitor();
                        const geometry = display.get_monitor_geometry(primaryMonitor);
                        menuWidth = Math.round(geometry.width * 0.115);
                        this._powerMenuWidth = menuWidth; // Store it
                    }
                    this._powerMenuContainer.set_width(menuWidth);
                    // Apply width via CSS as well to ensure it's enforced
                    _applyScaledStyle(this._powerMenuContainer, {
                        'width': menuWidth,
                        'min-width': menuWidth,
                        'max-width': menuWidth
                    });
                    
                    // Also enforce inner buttons container width
                    let buttonsWidth = this._powerMenuButtonsWidth;
                    if (!buttonsWidth) {
                        const display = global.display;
                        const primaryMonitor = display.get_primary_monitor();
                        const geometry = display.get_monitor_geometry(primaryMonitor);
                        buttonsWidth = Math.round(geometry.width * 0.115);
                        this._powerMenuButtonsWidth = buttonsWidth; // Store it
                    }
                    if (this._powerMenuButtons) {
                        this._powerMenuButtons.set_width(buttonsWidth);
                        _applyScaledStyle(this._powerMenuButtons, {
                            'width': buttonsWidth,
                            'min-width': buttonsWidth,
                            'max-width': buttonsWidth
                        });
                    }
                } catch (e) {
                    // If width setting fails, continue anyway
                }
                
                this._powerMenuContainer.show();
                this._powerMenuContainer.set_opacity(255);
                let parent = this._powerMenuContainer.get_parent();
                if (parent) {
                    parent.set_child_above_sibling(this._powerMenuContainer, null);
                }
                // Remove hover highlight when power menu opens
                if (powerButton && isHovering) {
                    removeHoverStyle();
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
            } catch (e) {
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
        powerIcon.set_reactive(false); // Don't block hover events
        powerIcon.set_style('pointer-events: none !important;'); // Ensure icon doesn't block hover
        powerButton.set_child(powerIcon);
        
        // Background color is now handled entirely by CSS (:hover, :active, :focus states)
        // No JavaScript background manipulation needed - CSS handles it all
        
        powerButton.set_x_expand(false); // Don't expand - use explicit size
        powerButton.set_y_expand(false); // Don't expand - use explicit size
        powerButton.set_x_align(Clutter.ActorAlign.CENTER); // Center in container
        powerButton.set_y_align(Clutter.ActorAlign.CENTER); // Center in container
        
        // Explicitly set power button to square size (same as container)
        // This ensures it's independent and square
        powerButton.set_width(powerButtonSize);
        powerButton.set_height(powerButtonSize);
        
        // Ensure the button clips its background to the rounded corners
        // CSS overflow: hidden should handle this, but we also set clip-to-allocation as a backup
        powerButton.set_clip_to_allocation(true);
        
        powerBox.add_child(powerButton);
        powerBox.show();
        powerButton.show();
        this._powerButton = powerButton;
        this._buttonList.push(powerButton);
        this._buttonCanvas = buttonCanvas;
        this._positionUpdateId = null;
        this._sizeUpdateId = null;

        // Add hover event handlers to ensure CSS works even when button doesn't have focus
        // This fixes the issue where hover styles don't work when button is not selected with arrow keys
        // Use inline CSS styles via set_style() to respect border-radius while bypassing CSS !important
        let isHovering = false;
        let isClicking = false;
        let baseBackgroundStyle = 'background-color: rgba(0, 0, 0, 0.85) !important;';
        let hoverBackgroundStyle = 'background-color: rgba(200, 200, 200, 0.2) !important;'; // More transparent hover
        let clickBackgroundStyle = 'background-color: rgba(200, 200, 200, 0.5) !important;'; // Brighter on click
        
        // Set initial background color
        powerButton.set_style(baseBackgroundStyle);
        
        const applyHoverStyle = () => {
            if (powerButton) {
                // Don't apply hover if power menu is open or if clicking
                if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                    return;
                }
                if (isClicking) {
                    return; // Don't apply hover while clicking
                }
                let currentFocus = global.stage ? global.stage.get_key_focus() : null;
                // Only apply JavaScript hover styles if button doesn't have focus
                // If it has focus, let CSS :hover handle it
                if (currentFocus !== powerButton) {
                    // Use inline CSS style to set background-color (respects border-radius)
                    // Inline styles with !important override CSS
                    let currentStyle = powerButton.get_style() || '';
                    // Remove any existing background-color
                    currentStyle = currentStyle.replace(/background-color\s*:[^;]+;?/gi, '');
                    // Add hover background with lower opacity (more transparent)
                    powerButton.set_style(currentStyle + ' ' + hoverBackgroundStyle);
                    // Keep icon at full opacity by ensuring button opacity stays at 255
                    powerButton.set_opacity(255); // Keep button at full opacity so icon stays bright
                    // Force a redraw to ensure the style is applied
                    if (powerButton.get_parent()) {
                        powerButton.get_parent().queue_redraw();
                    }
                }
            }
        };
        
        const removeHoverStyle = () => {
            if (powerButton) {
                // Don't remove hover if clicking (click style takes precedence)
                if (isClicking) {
                    return;
                }
                let currentFocus = global.stage ? global.stage.get_key_focus() : null;
                // Only remove JavaScript hover styles if button doesn't have focus
                if (currentFocus !== powerButton) {
                    // Use inline CSS style to restore base background
                    let currentStyle = powerButton.get_style() || '';
                    // Remove any existing background-color
                    currentStyle = currentStyle.replace(/background-color\s*:[^;]+;?/gi, '');
                    // Add base background
                    powerButton.set_style(currentStyle + ' ' + baseBackgroundStyle);
                    // Keep button at full opacity
                    powerButton.set_opacity(255); // Full opacity
                    // Force a redraw to ensure the style is applied
                    if (powerButton.get_parent()) {
                        powerButton.get_parent().queue_redraw();
                    }
                }
            }
        };
        
        const applyClickStyle = () => {
            if (powerButton) {
                let currentFocus = global.stage ? global.stage.get_key_focus() : null;
                // Only apply JavaScript click styles if button doesn't have focus
                if (currentFocus !== powerButton) {
                    let currentStyle = powerButton.get_style() || '';
                    // Remove any existing background-color
                    currentStyle = currentStyle.replace(/background-color\s*:[^;]+;?/gi, '');
                    // Add click background (brighter)
                    powerButton.set_style(currentStyle + ' ' + clickBackgroundStyle);
                    // Keep button at full opacity
                    powerButton.set_opacity(255);
                    // Force a redraw
                    if (powerButton.get_parent()) {
                        powerButton.get_parent().queue_redraw();
                    }
                }
            }
        };
        
        const removeClickStyle = () => {
            if (powerButton) {
                let currentFocus = global.stage ? global.stage.get_key_focus() : null;
                // Only remove JavaScript click styles if button doesn't have focus
                if (currentFocus !== powerButton) {
                    let currentStyle = powerButton.get_style() || '';
                    // Remove any existing background-color
                    currentStyle = currentStyle.replace(/background-color\s*:[^;]+;?/gi, '');
                    // Restore hover or base background based on hover state
                    if (isHovering) {
                        powerButton.set_style(currentStyle + ' ' + hoverBackgroundStyle);
                    } else {
                        powerButton.set_style(currentStyle + ' ' + baseBackgroundStyle);
                    }
                    // Keep button at full opacity
                    powerButton.set_opacity(255);
                    // Force a redraw
                    if (powerButton.get_parent()) {
                        powerButton.get_parent().queue_redraw();
                    }
                }
            }
        };
        
        // Track mouse position to detect hover
        let checkHoverState = () => {
            if (!powerButton || powerButton.is_destroyed()) {
                return;
            }
            // Don't apply hover if power menu is open
            if (this._powerMenuContainer && this._powerMenuContainer.visible) {
                if (isHovering) {
                    isHovering = false;
                    removeHoverStyle();
                }
                return;
            }
            let [pointerX, pointerY] = global.get_pointer();
            let [buttonX, buttonY] = powerButton.get_transformed_position();
            let [buttonWidth, buttonHeight] = powerButton.get_size();
            
            let isOverButton = (
                pointerX >= buttonX &&
                pointerX <= buttonX + buttonWidth &&
                pointerY >= buttonY &&
                pointerY <= buttonY + buttonHeight
            );
            
            if (isOverButton && !isHovering) {
                isHovering = true;
                applyHoverStyle();
            } else if (!isOverButton && isHovering) {
                isHovering = false;
                removeHoverStyle();
            }
        };
        
        powerButton.connect('enter-event', (actor, event) => {
            if (!isHovering) {
                isHovering = true;
                applyHoverStyle();
            }
            return false; // Don't consume event
        });
        
        powerButton.connect('leave-event', (actor, event) => {
            if (isHovering) {
                isHovering = false;
                removeHoverStyle();
            }
            return false; // Don't consume event
        });
        
        powerButton.connect('motion-event', (actor, event) => {
            checkHoverState();
            return false; // Don't consume event
        });
        
        // Also poll to check hover state as a fallback
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!powerButton || powerButton.is_destroyed()) {
                return false; // Stop polling if button is destroyed
            }
            checkHoverState();
            return true; // Continue polling
        });
        
        // Monitor focus changes to switch between JavaScript and CSS hover styles
        // When button gets focus, let CSS handle hover; when it loses focus, use JavaScript
        let lastFocusState = false;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!powerButton || powerButton.is_destroyed()) {
                return false; // Stop polling if button is destroyed
            }
            let currentFocus = global.stage ? global.stage.get_key_focus() : null;
            let hasFocus = (currentFocus === powerButton);
            
            if (hasFocus !== lastFocusState) {
                lastFocusState = hasFocus;
                if (hasFocus) {
                    // Button gained focus - clear inline styles, let CSS :hover:focus handle it
                    // CSS will apply :focus and :hover:focus styles with proper border-radius
                    let currentStyle = powerButton.get_style() || '';
                    // Remove background-color from inline styles
                    currentStyle = currentStyle.replace(/background-color\s*:[^;]+;?/gi, '');
                    powerButton.set_style(currentStyle);
                } else {
                    // Button lost focus - reapply JavaScript hover style if hovering
                    if (isHovering) {
                        applyHoverStyle();
                    } else {
                        // Restore base background
                        removeHoverStyle();
                    }
                }
            }
            return true; // Continue polling
        });

        const togglePowerMenu = (initialIndex = null) => {
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
                // Remove focus from stage first
                if (global.stage) {
                    global.stage.set_key_focus(null);
                }
                // Use idle_add to ensure focus is cleared after any pending operations
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (global.stage) {
                        global.stage.set_key_focus(null);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                // Don't set focus on first button when opened with mouse
                togglePowerMenu(null);
            } else {
                // Keyboard was used, so set focus on first button
                togglePowerMenu(wantsFocusTransition ? 0 : null);
            }
        });
        
        // Reset keyboard flag when mouse is used on power button
        // Also prevent focus from being set on mouse click
        // Decrease opacity on click for visual feedback
        powerButton.connect('button-press-event', (actor, event) => {
            this._usingKeyboard = false;
            // If this is a mouse click (not keyboard), prevent focus immediately
            if (global.stage) {
                let currentFocus = global.stage.get_key_focus();
                // If power button currently has focus, remove it immediately
                if (currentFocus === powerButton) {
                    global.stage.set_key_focus(null);
                }
            }
            // Apply brighter background on click
            isClicking = true;
            if (powerButton) {
                applyClickStyle();
            }
            return false;
        });
        
        // Remove click style when button is released
        powerButton.connect('button-release-event', (actor, event) => {
            isClicking = false;
            if (powerButton) {
                removeClickStyle();
            }
            return false;
        });

        powerButton.connect('key-press-event', (actor, event) => {
            this._usingKeyboard = true; // Mark that we're using keyboard
            let key = event.get_key_symbol();
            if (key === 0xFF0D || key === 0x20) {
                // Only Enter/Space opens the power menu - arrow keys should just navigate
                togglePowerMenu(0);
                return true;
            }

            if (key === 0xFF1B) {
                // ESC closes the power menu if it's open, otherwise let it propagate to close main dialog
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
            togglePowerMenu(0);
        };

        this._updateAnchorPositions();

        // Close power menu when clicking outside it
        // Connect to dialog actor to catch all clicks including on black background
        this._powerMenuClickOutsideId = this.actor.connect('button-press-event', (actor, event) => {
            // Only handle if power menu is visible
            if (!this._powerMenuContainer || !this._powerMenuContainer.visible) {
                return false; // Let other handlers process the event
            }

            // Get click coordinates in stage space
            let [stageX, stageY] = event.get_coords();
            
            // Transform stage coordinates to button canvas coordinates
            let [canvasX, canvasY, ok] = buttonCanvas.transform_stage_point(stageX, stageY);
            if (!ok) {
                // If transformation fails, assume click is outside (close menu)
                hidePowerMenu();
                return true;
            }
            
            // Get power menu container position and size (relative to button canvas)
            let [menuX, menuY] = this._powerMenuContainer.get_position();
            let [menuWidth, menuHeight] = this._powerMenuContainer.get_size();

            // Check if click is outside the power menu container
            let isOutside = (
                canvasX < menuX ||
                canvasX > menuX + menuWidth ||
                canvasY < menuY ||
                canvasY > menuY + menuHeight
            );

            // Also check if click is on the power button itself (should toggle, not just close)
            if (this._powerBox) {
                let [boxX, boxY] = this._powerBox.get_position();
                let [boxWidth, boxHeight] = this._powerBox.get_size();
                let isOnPowerButton = (
                    canvasX >= boxX &&
                    canvasX <= boxX + boxWidth &&
                    canvasY >= boxY &&
                    canvasY <= boxY + boxHeight
                );
                if (isOnPowerButton) {
                    // Click is on power button, let it handle the toggle
                    return false;
                }
            }

            // If click is outside power menu, close it
            if (isOutside) {
                hidePowerMenu();
                return true; // Consume the event
            }

            return false; // Let other handlers process the event
        });

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
                let stage = global.stage;
                // Filter out hidden buttons for navigation
                let visibleButtons = this._buttonList.filter(btn => btn && btn.visible && btn.get_visible());
                
                let focusActor = stage.get_key_focus();
                let currentIndex = -1;
                for (let i = 0; i < visibleButtons.length; i++) {
                    if (visibleButtons[i] === focusActor) {
                        currentIndex = i;
                        break;
                    }
                }
                
                if (currentIndex === -1 && visibleButtons.length > 0) {
                    visibleButtons[0].grab_key_focus();
                    return true;
                }
                
                if (key === 0xFF52) { // Up
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : visibleButtons.length - 1;
                    visibleButtons[newIndex].grab_key_focus();
                } else { // Down
                    let newIndex = currentIndex < visibleButtons.length - 1 ? currentIndex + 1 : 0;
                    visibleButtons[newIndex].grab_key_focus();
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
                let stage = global.stage;
                // Filter out hidden buttons for navigation
                let visibleButtons = this._buttonList.filter(btn => btn && btn.visible && btn.get_visible());
                
                let focusActor = stage.get_key_focus();
                let currentIndex = -1;
                for (let i = 0; i < visibleButtons.length; i++) {
                    if (visibleButtons[i] === focusActor) {
                        currentIndex = i;
                        break;
                    }
                }
                
                if (currentIndex === -1 && visibleButtons.length > 0) {
                    visibleButtons[0].grab_key_focus();
                    return true;
                }
                
                let shiftPressed = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
                if (shiftPressed) {
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : visibleButtons.length - 1;
                    visibleButtons[newIndex].grab_key_focus();
                } else {
                    let newIndex = currentIndex < visibleButtons.length - 1 ? currentIndex + 1 : 0;
                    visibleButtons[newIndex].grab_key_focus();
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
        
        // Use stored fixed width to prevent jitter - never recalculate or read from get_size()
        let menuWidth = this._powerMenuWidth;
        if (!menuWidth) {
            // Calculate if not stored yet (shouldn't happen, but fallback)
            try {
                const display = global.display;
                const primaryMonitor = display.get_primary_monitor();
                const geometry = display.get_monitor_geometry(primaryMonitor);
                menuWidth = Math.round(geometry.width * 0.115);
                this._powerMenuWidth = menuWidth; // Store it
            } catch (e) {
                // Last resort: read from size (but this shouldn't happen)
                [menuWidth] = this._powerMenuContainer.get_size();
            }
        }
        
        // Always enforce the stored width to prevent jitter
        this._powerMenuContainer.set_width(menuWidth);
        _applyScaledStyle(this._powerMenuContainer, {
            'width': menuWidth,
            'min-width': menuWidth,
            'max-width': menuWidth
        });
        
        // Get height from actual size (width is fixed, height is dynamic based on content)
        let [, menuHeight] = this._powerMenuContainer.get_size();
        if (menuHeight === 0) {
            let [, , , natHeight] = this._powerMenuContainer.get_preferred_size();
            menuHeight = natHeight;
        }
        
        // Position menu above the power button, right-aligned
        // Right edge of menu aligns with right edge of power button
        // Use height-based scaling for gap to prevent stretching on ultra-wide monitors
        let gapSize = 8; // Base gap
        try {
            const display = global.display;
            const primaryMonitor = display.get_primary_monitor();
            const geometry = display.get_monitor_geometry(primaryMonitor);
            const heightScale = geometry.height / BASE_HEIGHT;
            gapSize = Math.round(8 * heightScale);
        } catch (e) {
            // Use base gap if calculation fails
        }
        let menuX = powerX + powerWidth - menuWidth;
        let menuY = powerY - menuHeight - gapSize; // Scaled gap above button
        
        // Ensure menu stays within canvas boundaries
        menuX = Math.max(0, Math.min(menuX, canvasWidth - menuWidth));
        menuY = Math.max(0, menuY); // Allow menu to go above if there's space, but not below 0
        
        // Get current position to check if it actually changed
        let [currentX, currentY] = this._powerMenuContainer.get_position();
        if (currentX !== menuX || currentY !== menuY) {
            this._powerMenuContainer.set_position(menuX, menuY);
        }
        
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

    _setContainerWidths(monitorGeometry = null) {
        // Set container widths synchronously before dialog is shown
        // This prevents visual glitches where containers resize after being displayed
        // If monitorGeometry is provided, use it; otherwise use primary monitor
        try {
            let geometry;
            if (monitorGeometry) {
                geometry = monitorGeometry;
            } else {
                const display = global.display;
                const primaryMonitor = display.get_primary_monitor();
                geometry = display.get_monitor_geometry(primaryMonitor);
            }
            
            // Set container widths using percentage calculation to ensure consistent visual size
            // across all resolutions (1080p, 1440p, 4K, etc.)
            // 10.83% for button column (13% / 1.2 = 10.83%), 11.5% for power menu
            
            // Set button column width (10.83% of screen width - 1.2x smaller than 13%)
            // Cancel button is independent and can overflow the column width
            if (this._buttonColumn) {
                let columnWidth = Math.round(geometry.width * 0.1083);
                this._buttonColumn.set_width(columnWidth);
                
                // Apply scaled spacing and padding based on height to prevent stretching on ultra-wide monitors
                // Use height-based scaling to maintain consistent appearance across 16:9, 21:9, 31:9
                let heightScale = geometry.height / BASE_HEIGHT;
                let scaledSpacing = Math.round(4 * heightScale); // Base spacing is 4px (half of 8px), scale by height
                
                // Apply scaled padding and spacing via CSS - use height-based scaling to prevent horizontal stretching
                let scaledPadding = Math.round(16 * heightScale); // Base padding is 16px, scale by height
                _applyScaledStyle(this._buttonColumn, {
                    'padding': scaledPadding,
                    'spacing': scaledSpacing
                });
            }
            
            // Set power menu buttons container width (11.5% of screen width)
            // This is the inner container that holds the buttons - must be fixed to prevent jitter
            if (this._powerMenuButtons) {
                let menuWidth = Math.round(geometry.width * 0.115);
                this._powerMenuButtonsWidth = menuWidth; // Store fixed width
                this._powerMenuButtons.set_width(menuWidth);
                // Enforce width via CSS to prevent jitter
                _applyScaledStyle(this._powerMenuButtons, {
                    'width': menuWidth,
                    'min-width': menuWidth,
                    'max-width': menuWidth
                });
            }
            
            // Set power menu container width to match buttons container to prevent jitter
            // This ensures the outer container has a fixed width and doesn't resize based on content
            if (this._powerMenuContainer) {
                let menuWidth = Math.round(geometry.width * 0.115);
                this._powerMenuWidth = menuWidth; // Store fixed width
                this._powerMenuContainer.set_width(menuWidth);
                // Apply width via CSS as well to ensure it's enforced
                _applyScaledStyle(this._powerMenuContainer, {
                    'width': menuWidth,
                    'min-width': menuWidth,
                    'max-width': menuWidth
                });
            }
            
            // Set button widths using calculated container widths
            if (this._buttonColumn && this._buttonList) {
                let columnWidth = Math.round(geometry.width * 0.1083);
                // Subtract padding using height-based scaling to prevent stretching on ultra-wide monitors
                let heightScale = geometry.height / BASE_HEIGHT;
                let totalPadding = Math.round(32 * heightScale); // 16px left + 16px right = 32px base
                let buttonWidth = columnWidth - totalPadding;
                for (let button of this._buttonList) {
                    // Set Cancel button width explicitly (22% of screen width - slightly smaller)
                    // Must be independent of text length and can overflow parent container
                    if (button.get_style_class_name && button.get_style_class_name().includes('cancel-button')) {
                        let cancelWidth = Math.round(geometry.width * 0.22); // 22% of screen width (slightly smaller)
                        // Calculate 10% margin from left and right (10% of button column width, which is 10.83% of screen)
                        let columnWidth = Math.round(geometry.width * 0.1083);
                        let leftMargin = Math.round(columnWidth * 0.10); // 10% of column width
                        let rightMargin = Math.round(columnWidth * 0.10); // 10% of column width
                        
                        // Force width multiple times to ensure it sticks
                        button.set_width(cancelWidth);
                        button.set_x_expand(false); // Don't expand, use fixed width
                        button.set_x_align(Clutter.ActorAlign.START); // Align to start to allow margin
                        
                        // Constrain label inside button to not affect button width
                        let labelChild = button.get_child();
                        if (labelChild) {
                            if (labelChild.set_x_expand) {
                                labelChild.set_x_expand(false);
                            }
                            // Set label to fill button width but not constrain it
                            if (labelChild.set_width) {
                                labelChild.set_width(cancelWidth);
                            }
                        }
                        
                        // Force width and margin using CSS with !important
                        _applyScaledStyle(button, {
                            'width': cancelWidth,
                            'min-width': cancelWidth,
                            'max-width': cancelWidth,
                            'margin-left': leftMargin,
                            'margin-right': rightMargin,
                            'flex-shrink': 0,
                            'flex-grow': 0
                        });
                        
                        // Set width again after CSS to ensure it's applied
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (button && !button.is_destroyed()) {
                                button.set_width(cancelWidth);
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                        
                        continue;
                    }
                    // Skip power button - it has its own independent sizing
                    if (button === this._powerButton || (button.get_style_class_name && button.get_style_class_name().includes('ctrl-alt-del-power-button'))) {
                        continue;
                    }
                    button.set_width(buttonWidth);
                    
                    // Apply scaled padding and min-height to buttons for consistent appearance
                    // Use height-based scaling for all padding to prevent stretching on ultra-wide monitors
                    // This ensures buttons look the same on 16:9, 21:9, and 31:9 aspect ratios
                    let heightScale = geometry.height / BASE_HEIGHT;
                    _applyScaledStyle(button, {
                        'padding-top': Math.round(4 * heightScale), // Half of 8px
                        'padding-bottom': Math.round(4 * heightScale), // Half of 8px
                        'padding-left': Math.round(16 * heightScale), // Use height scale to prevent horizontal stretching
                        'padding-right': Math.round(16 * heightScale), // Use height scale to prevent horizontal stretching
                        'min-height': Math.round(50 * heightScale) // Half of 60px
                    });
                }
            }
            
            // Set power option button widths using calculated container width
            // This must be done to prevent jitter from content-based sizing
            if (this._powerMenuButtons && this._powerOptionButtons) {
                let menuWidth = Math.round(geometry.width * 0.115);
                // Subtract padding using height-based scaling to prevent stretching on ultra-wide monitors
                let heightScale = geometry.height / BASE_HEIGHT;
                let totalPadding = Math.round(16 * heightScale); // 8px left + 8px right = 16px base
                let buttonWidth = menuWidth - totalPadding;
                for (let button of this._powerOptionButtons) {
                    button.set_width(buttonWidth);
                    // Also enforce width via CSS to prevent jitter
                    _applyScaledStyle(button, {
                        'width': buttonWidth,
                        'min-width': buttonWidth,
                        'max-width': buttonWidth
                    });
                }
            }
        } catch (e) {
            global.log('Ctrl+Alt+Del: Error setting container widths: ' + e);
            // Fallback: Use percentage calculation if geometry is available
            try {
                const display = global.display;
                const primaryMonitor = display.get_primary_monitor();
                const geometry = display.get_monitor_geometry(primaryMonitor);
                
                if (this._buttonColumn) {
                    let columnWidth = Math.round(geometry.width * 0.1083);
                    this._buttonColumn.set_width(columnWidth);
                    
                    // Apply height-based scaling for spacing and padding
                    let heightScale = geometry.height / BASE_HEIGHT;
                    let scaledSpacing = Math.round(4 * heightScale); // Base spacing is 4px (half of 8px)
                    let scaledPadding = Math.round(16 * heightScale);
                    _applyScaledStyle(this._buttonColumn, {
                        'padding': scaledPadding,
                        'spacing': scaledSpacing
                    });
                    
                    if (this._buttonList) {
                        let totalPadding = Math.round(32 * heightScale);
                        let buttonWidth = columnWidth - totalPadding;
                        for (let button of this._buttonList) {
                            // Set Cancel button width explicitly (22% of screen width - slightly smaller)
                            if (button.get_style_class_name && button.get_style_class_name().includes('cancel-button')) {
                                let cancelWidth = Math.round(geometry.width * 0.22); // 22% of screen width (slightly smaller)
                                // Calculate 10% margin from left and right (10% of button column width, which is 10.83% of screen)
                                let columnWidth = Math.round(geometry.width * 0.1083);
                                let leftMargin = Math.round(columnWidth * 0.10); // 10% of column width
                                let rightMargin = Math.round(columnWidth * 0.10); // 10% of column width
                                button.set_width(cancelWidth);
                                button.set_x_align(Clutter.ActorAlign.START); // Align to start to allow margin
                                _applyScaledStyle(button, {
                                    'width': cancelWidth,
                                    'min-width': cancelWidth,
                                    'max-width': cancelWidth,
                                    'margin-left': leftMargin,
                                    'margin-right': rightMargin
                                });
                                continue;
                            }
                            if (button === this._powerButton || (button.get_style_class_name && button.get_style_class_name().includes('ctrl-alt-del-power-button'))) {
                                continue;
                            }
                            button.set_width(buttonWidth);
                            
                            // Apply height-based scaling for button padding and min-height
                            _applyScaledStyle(button, {
                                'padding-top': Math.round(4 * heightScale), // Half of 8px
                                'padding-bottom': Math.round(4 * heightScale), // Half of 8px
                                'padding-left': Math.round(16 * heightScale),
                                'padding-right': Math.round(16 * heightScale),
                                'min-height': Math.round(30 * heightScale) // Half of 60px
                            });
                        }
                    }
                }
                
                if (this._powerMenuButtons) {
                    let menuWidth = Math.round(geometry.width * 0.115);
                    this._powerMenuButtonsWidth = menuWidth; // Store fixed width
                    this._powerMenuButtons.set_width(menuWidth);
                    // Enforce width via CSS to prevent jitter
                    _applyScaledStyle(this._powerMenuButtons, {
                        'width': menuWidth,
                        'min-width': menuWidth,
                        'max-width': menuWidth
                    });
                    
                    if (this._powerOptionButtons) {
                        let heightScale = geometry.height / BASE_HEIGHT;
                        let totalPadding = Math.round(16 * heightScale);
                        let buttonWidth = menuWidth - totalPadding;
                        for (let button of this._powerOptionButtons) {
                            button.set_width(buttonWidth);
                            // Also enforce width via CSS to prevent jitter
                            _applyScaledStyle(button, {
                                'width': buttonWidth,
                                'min-width': buttonWidth,
                                'max-width': buttonWidth
                            });
                        }
                    }
                }
                
                // Set power menu container width to match buttons container to prevent jitter
                if (this._powerMenuContainer) {
                    let menuWidth = Math.round(geometry.width * 0.115);
                    this._powerMenuWidth = menuWidth; // Store fixed width
                    this._powerMenuContainer.set_width(menuWidth);
                    // Apply width via CSS as well to ensure it's enforced
                    _applyScaledStyle(this._powerMenuContainer, {
                        'width': menuWidth,
                        'min-width': menuWidth,
                        'max-width': menuWidth
                    });
                }
            } catch (e2) {
                global.log('Ctrl+Alt+Del: Error in fallback width setting: ' + e2);
            }
        }
    }

    open() {
        let display = global.display;
        
        // Check for multiple users and show/hide switch user button accordingly
        // Check immediately and also in idle callback to ensure it's shown
        if (this._switchUserButton) {
            let hasMultiple = _hasMultipleUsers();
            
            if (hasMultiple) {
                // Multiple users exist - show the button immediately with all methods
                // Use multiple approaches to ensure it's visible
                // First ensure parent is visible
                if (this._switchUserButton.get_parent()) {
                    this._switchUserButton.get_parent().show();
                    this._switchUserButton.get_parent().visible = true;
                }
                // Then show the button itself
                this._switchUserButton.visible = true;
                this._switchUserButton.set_opacity(255);
                this._switchUserButton.show();
                this._switchUserButton.can_focus = true;
                // Force remove any hiding styles and ensure visibility
                this._switchUserButton.set_style('opacity: 1 !important; visibility: visible !important; display: block !important;');
            } else {
                // Only 1 user - hide the button
                this._switchUserButton.hide();
                this._switchUserButton.visible = false;
                this._switchUserButton.can_focus = false;
            }
        }
        
        // Also check in idle callback to ensure it stays visible after dialog is fully rendered
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._switchUserButton) {
                // Check if multiple users exist and show/hide the button accordingly
                let hasMultiple = _hasMultipleUsers();
                
                if (hasMultiple) {
                    // Multiple users exist (> 1) - show the button
                    // Force visibility with multiple methods to ensure it's shown
                    this._switchUserButton.visible = true;
                    this._switchUserButton.set_opacity(255);
                    this._switchUserButton.show();
                    this._switchUserButton.can_focus = true;
                    // Remove any CSS that might hide it and force visibility
                    let currentStyle = this._switchUserButton.get_style() || '';
                    // Remove any opacity/visibility/display rules that might hide it
                    let cleanStyle = currentStyle.replace(/opacity\s*:[^;]+;?/gi, '')
                                                 .replace(/visibility\s*:[^;]+;?/gi, '')
                                                 .replace(/display\s*:[^;]+;?/gi, '');
                    this._switchUserButton.set_style(cleanStyle + ' opacity: 1 !important; visibility: visible !important; display: block !important;');
                    // Ensure button is in the layout and visible
                    if (this._switchUserButton.get_parent()) {
                        this._switchUserButton.get_parent().queue_redraw();
                    }
                    // Force a second check after a short delay to ensure it stays visible
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        if (this._switchUserButton && _hasMultipleUsers()) {
                            this._switchUserButton.visible = true;
                            this._switchUserButton.set_opacity(255);
                            this._switchUserButton.show();
                            this._switchUserButton.can_focus = true;
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    // Only 1 user exists - hide the button
                    this._switchUserButton.hide();
                    this._switchUserButton.visible = false;
                    this._switchUserButton.can_focus = false;
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        
        // Set container widths BEFORE opening dialog to prevent visual glitches
        this._setContainerWidths();
        
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
        
        // Update container widths based on actual monitor (in case it's different from primary)
        this._setContainerWidths(monitorGeometry);
        
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

        // No allocation signal to disconnect (we removed it to prevent jitter)
        this._powerMenuAllocationId = null;

        if (this._powerMenuClickOutsideId && this.actor) {
            try {
                this.actor.disconnect(this._powerMenuClickOutsideId);
            } catch (e) {}
            this._powerMenuClickOutsideId = null;
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

        // No allocation signal to disconnect (we removed it to prevent jitter)
        this._powerMenuAllocationId = null;

        if (this._powerMenuClickOutsideId && this.actor) {
            try {
                this.actor.disconnect(this._powerMenuClickOutsideId);
            } catch (e) {}
            this._powerMenuClickOutsideId = null;
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


function enable() {
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
            } catch (e) {
                global.log('Ctrl+Alt+Del: Could not register keybinding: ' + e);
            }
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Keybinding setup failed: ' + e);
    }
    
    // Set up file-based trigger polling
    _triggerFile = Gio.file_new_for_path(GLib.get_home_dir() + '/.ctrl-alt-del-trigger');
    
    _pollingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, function() {
        try {
            if (_triggerFile && _triggerFile.query_exists(null)) {
                try {
                    _triggerFile.delete(null);
                } catch (e) {}
                
                _handleCtrlAltDel();
                return true;
            }
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
}