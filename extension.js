const { GObject, St, Clutter, GLib, Gio } = imports.gi;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;

let _ctrlAltDelDialog = null; 
let _triggerFile = null;
let _blackOverlays = [];
let _isLocking = false;
let _isOpeningOrClosing = false;
let _lastToggleTime = 0;
let _pollingId = null;

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
    
    let display = global.display;
    let nMonitors = display.get_n_monitors();
    let targetGroup = parentGroup || Main.uiGroup;
    
    for (let i = 0; i < nMonitors; i++) {
        let monitorGeometry = display.get_monitor_geometry(i);
        let overlay = new St.Widget({
            style_class: 'ctrl-alt-del-black-overlay',
            x: monitorGeometry.x,
            y: monitorGeometry.y,
            width: monitorGeometry.width + 2,
            height: monitorGeometry.height + 2,
            reactive: false,
        });
        
        overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
        targetGroup.add_child(overlay);
        overlay.show();
        overlay.set_opacity(255);
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
const CtrlAltDelDialog = GObject.registerClass(
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

        let vbox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style_class: 'ctrl-alt-del-content',
        });
        this.contentLayout.add_child(vbox);

        let buttons = new St.BoxLayout({
            vertical: true,
            style_class: 'ctrl-alt-del-buttons',
            x_align: Clutter.ActorAlign.CENTER,
        });
        vbox.add_child(buttons);

        this._buttonList = [];

        const makeBtn = (label, cb, style = 'ctrl-alt-del-button') => {
            let b = new St.Button({ 
                label, 
                style_class: style,
                can_focus: true,
                reactive: true
            });
            b.connect('clicked', () => cb());
            
            b.connect('key-press-event', (actor, event) => {
                let key = event.get_key_symbol();
                if (key === 0xFF0D || key === 0x20) { // Enter or Space
                    cb();
                    return true;
                }
                return false;
            });
            
            buttons.add_child(b);
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
                let currentIndex = -1;
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i].has_focus()) {
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
                let currentIndex = -1;
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i].has_focus()) {
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

    open() {
        let display = global.display;
        let primaryMonitor = display.get_primary_monitor();
        let primaryGeometry = display.get_monitor_geometry(primaryMonitor);
        
        _createBlackOverlays(Main.uiGroup);
        Main.uiGroup.queue_redraw();
        
        super.open();
        
        this.actor.set_size(primaryGeometry.width, primaryGeometry.height);
        this.actor.set_position(primaryGeometry.x, primaryGeometry.y);
        
        // Move overlays to dialog's parent and ensure proper z-ordering
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            let dialogParent = this.actor.get_parent();
            if (!dialogParent) return false;
            
            // Move overlays to dialog parent
            for (let i = 0; i < _blackOverlays.length; i++) {
                let overlay = _blackOverlays[i];
                let currentParent = overlay.get_parent();
                let monitorGeometry = display.get_monitor_geometry(i);
                
                if (!currentParent) {
                    dialogParent.add_child(overlay);
                } else if (currentParent !== dialogParent) {
                    currentParent.remove_child(overlay);
                    dialogParent.add_child(overlay);
                }
                
                overlay.set_size(monitorGeometry.width + 2, monitorGeometry.height + 2);
                overlay.set_position(monitorGeometry.x, monitorGeometry.y);
                overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
                overlay.show();
                overlay.set_opacity(255);
            }
            
            // Raise dialog above overlays
            if (_blackOverlays.length > 0) {
                try {
                    let lastOverlay = _blackOverlays[_blackOverlays.length - 1];
                    dialogParent.set_child_above_sibling(this.actor, lastOverlay);
                } catch (e) {}
            }
            
            return false;
        });
        
        // Focus first button
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this._buttonList && this._buttonList.length > 0) {
                this._buttonList[0].grab_key_focus();
            }
            return false;
        });
    }
    
    close() {
        if (this._overlayUpdateId) {
            GLib.source_remove(this._overlayUpdateId);
            this._overlayUpdateId = null;
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
        
        if (this._keyId) {
            try {
                this.actor.disconnect(this._keyId);
            } catch (e) {}
            this._keyId = null;
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
        global.log('Ctrl+Alt+Del: Error creating/opening dialog: ' + e);
        _ctrlAltDelDialog = null;
        _isOpeningOrClosing = false;
    }
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
    
    _pollingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, function() {
        try {
            if (_isLocking) {
                return true;
            }
            
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
}
