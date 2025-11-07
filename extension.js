const { GObject, St, Clutter, GLib, Gio } = imports.gi;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const EndSessionDialog = imports.ui.endSessionDialog;

let _ctrlAltDelDialog = null; 
let _triggerFile = null;
let _blackOverlays = [];
let _isLocking = false; // Flag to prevent re-opening during lock operation
let _isOpeningOrClosing = false; // Flag to prevent rapid toggling
let _lastToggleTime = 0; // Timestamp of last toggle to implement debouncing
let _globalKeybindingId = null; // Global keybinding handler ID

// File-based logging system for crash diagnosis
let _logFile = null;
let _logFileStream = null;
let _logBackupFile = null;
let _logBackupFileStream = null;
let _logBuffer = '';
let _logFlushTimeoutId = null;
let _logStartTime = null;
 let _crashMarkerFile = null; // Separate crash marker file for immediate writes

// Initialize file logging with dual-file system for crash resilience
function _initFileLogging() {
    try {
        let logPath = GLib.get_home_dir() + '/.ctrl-alt-del-lock-diagnosis.log';
        let backupLogPath = GLib.get_home_dir() + '/.ctrl-alt-del-lock-diagnosis-backup.log';
        
        // Primary log file
        _logFile = Gio.file_new_for_path(logPath);
        let fileExists = _logFile.query_exists(null);
        
        if (fileExists) {
            _logFileStream = _logFile.append_to(Gio.FileCreateFlags.NONE, null);
        } else {
            _logFileStream = _logFile.create(Gio.FileCreateFlags.NONE, null);
        }
        
        // Backup log file (always append, never truncate)
        _logBackupFile = Gio.file_new_for_path(backupLogPath);
        let backupExists = _logBackupFile.query_exists(null);
        
        if (backupExists) {
            _logBackupFileStream = _logBackupFile.append_to(Gio.FileCreateFlags.NONE, null);
        } else {
            _logBackupFileStream = _logBackupFile.create(Gio.FileCreateFlags.NONE, null);
        }
        
        _logBuffer = '';
        _logStartTime = Date.now();
        
        // Add session separator if appending to existing file
        let sessionHeader = '';
        if (fileExists) {
            sessionHeader = '\n\n========================================\n';
            sessionHeader += 'NEW SESSION STARTED (Previous session may have crashed)\n';
        } else {
            sessionHeader = '========================================\n';
            sessionHeader += 'Ctrl+Alt+Del Lock Diagnosis Log Started\n';
        }
        sessionHeader += 'Timestamp: ' + new Date().toISOString() + '\n';
        sessionHeader += '========================================\n\n';
        
        // Write session header DIRECTLY (bypass buffer) to both files
        _writeDirectly(sessionHeader);
        
        // Start periodic flush (every 50ms for faster writes during crashes)
        _logFlushTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            _flushLogBuffer();
            return true; // Continue flushing
        });
        
        // Initialize crash marker file (separate file for immediate crash detection)
        let crashMarkerPath = GLib.get_home_dir() + '/.ctrl-alt-del-crash-marker.log';
        _crashMarkerFile = Gio.file_new_for_path(crashMarkerPath);
        
        global.log('Ctrl+Alt+Del: File logging initialized (PRIMARY + BACKUP + CRASH MARKER, APPEND MODE)');
    } catch (e) {
        global.log('Ctrl+Alt+Del: Failed to initialize file logging: ' + e);
    }
}

// Write to crash marker file immediately (most aggressive, separate file)
function _writeCrashMarker(message) {
    if (!message || !_crashMarkerFile) return;
    
    try {
        let timestamp = new Date().toISOString();
        let logLine = '[' + timestamp + '] ' + message + '\n';
        let bytes = new GLib.Bytes(logLine);
        
        // Open in append mode, write, flush multiple times, and close immediately
        // This ensures the file is synced to disk as aggressively as possible
        let stream = _crashMarkerFile.append_to(Gio.FileCreateFlags.NONE, null);
        if (stream) {
            try {
                stream.write_bytes(bytes, null);
                // Multiple flushes for maximum reliability
                stream.flush(null);
                // Schedule an additional flush after a tiny delay for maximum reliability
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    try {
                        if (stream) stream.flush(null);
                    } catch (e) {}
                    return false; // Don't repeat
                });
            } finally {
                stream.close(null);
            }
        }
    } catch (e) {
        // Silently fail - we don't want crash marker writes to cause errors
        global.log('Ctrl+Alt+Del: Crash marker write error (non-critical): ' + e);
    }
}

// DIRECT write function - bypasses buffer, writes immediately to both files
// Use this for critical operations that must survive crashes
function _writeDirectly(message) {
    if (!message) return;
    
    // FIRST: Write to crash marker file (most aggressive)
    _writeCrashMarker(message);
    
    try {
        let timestamp = Date.now() - (_logStartTime || 0);
        let logLine = '[' + timestamp + 'ms] ' + message + '\n';
        let bytes = new GLib.Bytes(logLine);
        
        // Write to primary file
        if (_logFileStream) {
            try {
                _logFileStream.write_bytes(bytes, null);
                _logFileStream.flush(null);
                // Schedule an additional flush for maximum reliability
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    try {
                        if (_logFileStream) _logFileStream.flush(null);
                    } catch (e) {}
                    return false; // Don't repeat
                });
            } catch (e) {
                global.log('Ctrl+Alt+Del: Error writing to primary log: ' + e);
                // Try to reinitialize stream
                try {
                    if (_logFile) {
                        _logFileStream = _logFile.append_to(Gio.FileCreateFlags.NONE, null);
                    }
                } catch (reinitErr) {}
            }
        }
        
        // Write to backup file
        if (_logBackupFileStream) {
            try {
                _logBackupFileStream.write_bytes(bytes, null);
                _logBackupFileStream.flush(null);
                // Schedule an additional flush for maximum reliability
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    try {
                        if (_logBackupFileStream) _logBackupFileStream.flush(null);
                    } catch (e) {}
                    return false; // Don't repeat
                });
            } catch (e) {
                global.log('Ctrl+Alt+Del: Error writing to backup log: ' + e);
                // Try to reinitialize stream
                try {
                    if (_logBackupFile) {
                        _logBackupFileStream = _logBackupFile.append_to(Gio.FileCreateFlags.NONE, null);
                    }
                } catch (reinitErr) {}
            }
        }
        
        // Also log to console
        global.log('Ctrl+Alt+Del [DIRECT]: ' + message);
    } catch (e) {
        global.log('Ctrl+Alt+Del: Critical error in _writeDirectly: ' + e);
    }
}

// Write to log buffer (will be flushed to disk every 1 second)
function _logToFile(message) {
    try {
        let timestamp = Date.now() - (_logStartTime || 0);
        let logLine = '[' + timestamp + 'ms] ' + message + '\n';
        _logBuffer += logLine;
        
        // Also log to console for immediate feedback
        global.log('Ctrl+Alt+Del [FILE]: ' + message);
    } catch (e) {
        global.log('Ctrl+Alt+Del: Error writing to log buffer: ' + e);
    }
}

// Flush log buffer to disk immediately (writes to both primary and backup)
function _flushLogBuffer() {
    if (!_logFileStream && !_logBackupFileStream) {
        return;
    }
    
    if (!_logBuffer) {
        // Even if buffer is empty, try to flush both streams
        try {
            if (_logFileStream) _logFileStream.flush(null);
            if (_logBackupFileStream) _logBackupFileStream.flush(null);
        } catch (e) {
            // Ignore flush errors if stream is already closed
        }
        return;
    }
    
    try {
        let bytes = new GLib.Bytes(_logBuffer);
        let bufferCopy = _logBuffer; // Save for backup write
        
        // Write to primary file
        if (_logFileStream) {
            try {
                _logFileStream.write_bytes(bytes, null);
                _logFileStream.flush(null);
                try {
                    _logFileStream.get_output_stream().flush(null);
                } catch (syncError) {}
            } catch (e) {
                global.log('Ctrl+Alt+Del: Error writing to primary log: ' + e);
                // Try to reinitialize
                try {
                    if (_logFile) {
                        _logFileStream = _logFile.append_to(Gio.FileCreateFlags.NONE, null);
                    }
                } catch (reinitError) {}
            }
        }
        
        // Write to backup file (use same buffer)
        if (_logBackupFileStream) {
            try {
                let backupBytes = new GLib.Bytes(bufferCopy);
                _logBackupFileStream.write_bytes(backupBytes, null);
                _logBackupFileStream.flush(null);
                try {
                    _logBackupFileStream.get_output_stream().flush(null);
                } catch (syncError) {}
            } catch (e) {
                global.log('Ctrl+Alt+Del: Error writing to backup log: ' + e);
                // Try to reinitialize
                try {
                    if (_logBackupFile) {
                        _logBackupFileStream = _logBackupFile.append_to(Gio.FileCreateFlags.NONE, null);
                    }
                } catch (reinitError) {}
            }
        }
        
        // Clear buffer
        _logBuffer = '';
    } catch (e) {
        global.log('Ctrl+Alt+Del: Error flushing log to disk: ' + e);
    }
}

// Log system state for diagnosis
function _logSystemState(context) {
    try {
        _logToFile('=== SYSTEM STATE: ' + context + ' ===');
        
        // Log GNOME Shell version
        try {
            let shellVersion = imports.misc.config.PACKAGE_VERSION;
            _logToFile('GNOME Shell version: ' + shellVersion);
        } catch (e) {
            _logToFile('Could not get Shell version: ' + e);
        }
        
        // Log display state
        try {
            let display = global.display;
            let nMonitors = display.get_n_monitors();
            _logToFile('Number of monitors: ' + nMonitors);
            for (let i = 0; i < nMonitors; i++) {
                let geom = display.get_monitor_geometry(i);
                _logToFile('Monitor ' + i + ': ' + geom.width + 'x' + geom.height + ' at (' + geom.x + ',' + geom.y + ')');
            }
        } catch (e) {
            _logToFile('Could not get display state: ' + e);
        }
        
        // Log dialog state
        _logToFile('Dialog exists: ' + (_ctrlAltDelDialog !== null));
        _logToFile('Dialog actor exists: ' + (_ctrlAltDelDialog && _ctrlAltDelDialog.actor !== null));
        _logToFile('Dialog actor parent: ' + (_ctrlAltDelDialog && _ctrlAltDelDialog.actor && _ctrlAltDelDialog.actor.get_parent() !== null));
        _logToFile('Is locking flag: ' + _isLocking);
        _logToFile('Black overlays count: ' + _blackOverlays.length);
        
        // Log Main.screenShield state
        try {
            if (Main.screenShield) {
                _logToFile('Main.screenShield exists: true');
                _logToFile('Main.screenShield.lock exists: ' + (typeof Main.screenShield.lock === 'function'));
            } else {
                _logToFile('Main.screenShield exists: false');
            }
        } catch (e) {
            _logToFile('Could not check Main.screenShield: ' + e);
        }
        
        // Log session state
        try {
            let sessionId = GLib.getenv('XDG_SESSION_ID');
            _logToFile('XDG_SESSION_ID: ' + (sessionId || 'not set'));
        } catch (e) {
            _logToFile('Could not get session ID: ' + e);
        }
        
        _logToFile('=== END SYSTEM STATE ===\n');
        _flushLogBuffer(); // Force flush after system state
    } catch (e) {
        _logToFile('Error logging system state: ' + e);
        _flushLogBuffer();
    }
}

// Function to check if there are multiple users on the system
function _hasMultipleUsers() {
    try {
        // Method 1: Check loginctl list-users (most reliable for active users)
        let [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync('loginctl list-users --no-legend');
        if (success && exitCode === 0) {
            let output = stdout.toString();
            let lines = output.split('\n').filter(line => line.trim().length > 0);
            let userCount = lines.length;
            global.log('Ctrl+Alt+Del: Found ' + userCount + ' users via loginctl');
            return userCount > 1;
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: loginctl check failed: ' + e);
    }

    try {
        // Method 2: Check /etc/passwd for human users (UID >= 1000)
        let passwdFile = Gio.file_new_for_path('/etc/passwd');
        if (passwdFile.query_exists(null)) {
            let [success, contents] = passwdFile.load_contents(null);
            if (success) {
                let lines = contents.toString().split('\n');
                let userCount = 0;
                for (let line of lines) {
                    let parts = line.split(':');
                    if (parts.length >= 3) {
                        let uid = parseInt(parts[2]);
                        // Human users typically have UID >= 1000
                        if (uid >= 1000 && uid < 65534) {
                            userCount++;
                        }
                    }
                }
                global.log('Ctrl+Alt+Del: Found ' + userCount + ' users via /etc/passwd');
                return userCount > 1;
            }
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: /etc/passwd check failed: ' + e);
    }

    // Default: assume single user if we can't determine
    global.log('Ctrl+Alt+Del: Could not determine user count, assuming single user');
    return false;
}

// Functions to create/remove black overlays for all monitors
// This mimics how EndSessionDialog creates full-screen backgrounds
// ModalDialog's lightbox only covers primary monitor, so we create overlays for all
function _createBlackOverlays(parentGroup) {
    _removeBlackOverlays(); // Clean up any existing

    let display = global.display;
    let nMonitors = display.get_n_monitors();

    // Use provided parent group, or default to Main.uiGroup
    let targetGroup = parentGroup || Main.uiGroup;

    for (let i = 0; i < nMonitors; i++) {
        let monitorGeometry = display.get_monitor_geometry(i);
        // Add 2 pixels to width/height to ensure full coverage (account for rounding/positioning issues)
        let overlay = new St.Widget({
            style_class: 'ctrl-alt-del-black-overlay',
            x: monitorGeometry.x,
            y: monitorGeometry.y,
            width: monitorGeometry.width + 2,
            height: monitorGeometry.height + 2,
            reactive: false, // Don't capture input
        });

        // Explicitly set black background color as fallback (CSS should handle it, but this ensures it works)
        overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));

        // Add to the same group as the dialog (or uiGroup if not specified)
        targetGroup.add_child(overlay);
        overlay.show(); // Explicitly show the overlay
        overlay.set_opacity(255); // Ensure fully opaque
        _blackOverlays.push(overlay);
        
        global.log('Ctrl+Alt+Del: Created overlay for monitor ' + i + ' at (' + 
                  monitorGeometry.x + ',' + monitorGeometry.y + ') size ' +
                  (monitorGeometry.width + 2) + 'x' + (monitorGeometry.height + 2));
    }

    global.log('Ctrl+Alt+Del: Created black overlays for ' + nMonitors + ' monitors');
}

function _removeBlackOverlays() {
    // Make a copy of the array to avoid issues if array is modified during iteration
    let overlaysToRemove = _blackOverlays.slice();
    _blackOverlays = []; // Clear array immediately
    
    for (let overlay of overlaysToRemove) {
        try {
            // Hide first to prevent flickering
            if (overlay) {
                overlay.hide();
            }
            
            // Remove from parent
            if (overlay && overlay.get_parent()) {
                overlay.get_parent().remove_child(overlay);
            }
            
            // Destroy the overlay
            if (overlay) {
                overlay.destroy();
            }
        } catch (e) {
            global.log('Ctrl+Alt+Del: Error removing overlay: ' + e);
        }
    }
    global.log('Ctrl+Alt+Del: Removed ' + overlaysToRemove.length + ' black overlays');
}

// Define dialog class first
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

        // Make the dialog cover the screen like Windows
        this.actor.layout_manager = new Clutter.BinLayout(); // stretch
        this.actor.add_style_class_name('full-fill');

        // Vertical box centered
        let vbox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style_class: 'ctrl-alt-del-content',
        });
        this.contentLayout.add_child(vbox);

        // Button column (St.BoxLayout vertical)
        let buttons = new St.BoxLayout({
            vertical: true,
            style_class: 'ctrl-alt-del-buttons',
            x_align: Clutter.ActorAlign.CENTER,
        });
        vbox.add_child(buttons);

        // Store all buttons for keyboard navigation
        this._buttonList = [];

        const makeBtn = (label, cb, style = 'ctrl-alt-del-button') => {
            let b = new St.Button({ 
                label, 
                style_class: style,
                can_focus: true,  // Enable keyboard focus
                reactive: true    // Enable mouse/keyboard interaction
            });
            b.connect('clicked', () => cb());
            
            // Handle Enter/Space key presses
            b.connect('key-press-event', (actor, event) => {
                let key = event.get_key_symbol();
                // Enter (0xFF0D) or Space (0x20)
                if (key === 0xFF0D || key === 0x20) {
                    cb();
                    return true; // Event handled
                }
                return false;
            });
            
            buttons.add_child(b);
            this._buttonList.push(b);
            return b;
        };

        // Lock button - ENABLED FOR DIAGNOSIS: Comprehensive logging enabled
        let lockButton = makeBtn('Lock', () => {
            // CRITICAL: Write crash marker FIRST (before anything else)
            // This is the most aggressive write - separate file, immediate sync
            _writeCrashMarker('LOCK BUTTON CLICKED - CRASH MARKER');
            
            // CRITICAL: Use DIRECT write for crash marker - bypasses buffer completely
            _writeDirectly('========================================');
            _writeDirectly('LOCK BUTTON CLICKED - STARTING DIAGNOSIS');
            _writeDirectly('========================================');
            
            // Also flush buffer in case anything was pending
            _flushLogBuffer();
            
            // Start aggressive flushing during lock operation (every 50ms)
            let aggressiveFlushId = GLib.timeout_add(GLib.PRIORITY_HIGH, 50, () => {
                _flushLogBuffer();
                return true; // Continue until we remove this timeout
            });
            
            // Store flush ID to remove it later
            let removeAggressiveFlush = () => {
                if (aggressiveFlushId) {
                    GLib.source_remove(aggressiveFlushId);
                    aggressiveFlushId = null;
                }
            };
            
            // Log system state BEFORE any operations
            _logSystemState('BEFORE LOCK OPERATION');
            
            // Set flag IMMEDIATELY to prevent re-opening during lock
            _isLocking = true;
            _writeDirectly('Set _isLocking = true'); // Direct write for critical state
            _flushLogBuffer();
            
            // CRITICAL: Disconnect key handler FIRST to prevent event conflicts during cleanup
            if (this._keyId) {
                try {
                    _logToFile('Disconnecting key handler (ID: ' + this._keyId + ')');
                    this.actor.disconnect(this._keyId);
                    this._keyId = null;
                    _logToFile('Key handler disconnected successfully');
                } catch (e) {
                    _logToFile('ERROR disconnecting key handler: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
                }
                _flushLogBuffer();
            } else {
                _logToFile('No key handler to disconnect');
            }
            
            // CRITICAL: Use close() which will properly clean up via destroy() chain
            // Don't manually remove from tree - let close() handle it properly
            try {
                _logToFile('Calling this.close() to clean up dialog');
                this.close();
                _logToFile('this.close() called successfully');
            } catch (e) {
                _logToFile('ERROR closing dialog: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
                // Force cleanup on error
                try {
                    _logToFile('Attempting force cleanup...');
                    _removeBlackOverlays();
                    if (_ctrlAltDelDialog === this) {
                        _ctrlAltDelDialog = null;
                        _logToFile('Global reference cleared');
                    }
                } catch (cleanupError) {
                    _logToFile('ERROR during force cleanup: ' + cleanupError + ' | Stack: ' + (cleanupError.stack || 'no stack'));
                }
            }
            _flushLogBuffer();
            
            // Log system state AFTER cleanup but BEFORE lock attempt
            _logSystemState('AFTER CLEANUP, BEFORE LOCK');
            
            // Lock immediately - no delay needed
            _writeDirectly('========================================');
            _writeDirectly('ATTEMPTING LOCK OPERATION (instant)');
            _writeDirectly('========================================');
            _flushLogBuffer();
            
            // Log system state right before lock attempt
            _logSystemState('IMMEDIATELY BEFORE LOCK ATTEMPT');
            
            try {
                // Method 1: Use Main.screenShield.lock() - the proper GNOME Shell API
                // This is the safest method as it uses the internal lock mechanism
                // that properly handles session mode transitions without causing segfaults
                _writeDirectly('Attempting Method 1: Main.screenShield.lock()');
                try {
                    if (Main.screenShield && typeof Main.screenShield.lock === 'function') {
                        Main.screenShield.lock();
                        _writeDirectly('Method 1 SUCCESS: Main.screenShield.lock() called');
                    } else {
                        throw new Error('Main.screenShield.lock is not available');
                    }
                } catch (e) {
                    _writeDirectly('Method 1 FAILED: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
                    
                    // Method 2: D-Bus ScreenSaver Lock (fallback)
                    _writeDirectly('Attempting Method 2: D-Bus ScreenSaver.Lock');
                    try {
                        GLib.spawn_command_line_async('dbus-send --session --type=method_call --dest=org.gnome.ScreenSaver /org/gnome/ScreenSaver org.gnome.ScreenSaver.Lock');
                        _writeDirectly('Method 2 SUCCESS: D-Bus ScreenSaver.Lock executed');
                    } catch (dbusError) {
                        _writeDirectly('Method 2 FAILED: ' + dbusError + ' | Stack: ' + (dbusError.stack || 'no stack'));
                        
                        // Method 3: gnome-screensaver-command (fallback)
                        _writeDirectly('Attempting Method 3: gnome-screensaver-command -l');
                        try {
                            GLib.spawn_command_line_async('gnome-screensaver-command -l');
                            _writeDirectly('Method 3 SUCCESS: gnome-screensaver-command executed');
                        } catch (screensaverError) {
                            _writeDirectly('Method 3 FAILED: ' + screensaverError + ' | Stack: ' + (screensaverError.stack || 'no stack'));
                            
                            // Method 4: loginctl lock-session (last resort - known to cause crashes)
                            // Only use this if all other methods fail, as it triggers problematic session mode changes
                            _writeDirectly('Attempting Method 4: loginctl lock-session (WARNING: may cause crashes)');
                            try {
                                GLib.spawn_command_line_async('loginctl lock-session');
                                _writeDirectly('Method 4 SUCCESS: loginctl lock-session executed (may cause system crash)');
                            } catch (sessionError) {
                                _writeDirectly('Method 4 FAILED: ' + sessionError + ' | Stack: ' + (sessionError.stack || 'no stack'));
                                _writeDirectly('ALL LOCK METHODS FAILED');
                            }
                        }
                    }
                }
            } catch (e) {
                _writeDirectly('CRITICAL ERROR in lock attempt: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
            }
            
            _flushLogBuffer();
            
            // Log system state AFTER lock attempt
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                _logSystemState('AFTER LOCK ATTEMPT (500ms later)');
                
                // Reset flag after a longer delay to ensure lock screen is fully initialized
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                    _logToFile('Resetting _isLocking flag (4000ms after lock attempt)');
                    _isLocking = false;
                    _logToFile('Lock flag reset, extension ready again');
                    _logToFile('========================================');
                    _logToFile('LOCK OPERATION COMPLETE');
                    _logToFile('========================================\n');
                    _flushLogBuffer();
                    removeAggressiveFlush(); // Stop aggressive flushing
                    return false;
                });
                return false;
            });
            
            _flushLogBuffer(); // Final flush
            
            // Also set up a cleanup in case of early exit
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                removeAggressiveFlush(); // Stop aggressive flushing after 10 seconds
                return false;
            });
        });
        
        global.log('Ctrl+Alt+Del: Lock button enabled with comprehensive logging');

        // Switch User button - only show if multiple users exist
        // Store reference to conditionally show/hide
        this._switchUserButton = null;
        if (_hasMultipleUsers()) {
            this._switchUserButton = makeBtn('Switch User', () => {
                global.log('Ctrl+Alt+Del: Switch User button clicked');
                this.close();
                try {
                    // Method 1: Use gdmflexiserver to show login screen (keeps current session)
                    // This is the GNOME way to switch users without logging out
                    GLib.spawn_command_line_async('gdmflexiserver');
                    global.log('Ctrl+Alt+Del: User switch initiated via gdmflexiserver');
                } catch (e) {
                    global.log('Ctrl+Alt+Del: gdmflexiserver failed: ' + e);
                    // Fallback: Use D-Bus to show login manager
                    try {
                        GLib.spawn_command_line_async('dbus-send --system --type=method_call --dest=org.freedesktop.DisplayManager /org/freedesktop/DisplayManager/Seat0 org.freedesktop.DisplayManager.Seat.SwitchToGreeter');
                        global.log('Ctrl+Alt+Del: User switch initiated via D-Bus DisplayManager');
                    } catch (dbusError) {
                        global.log('Ctrl+Alt+Del: D-Bus switch failed: ' + dbusError);
                        // Final fallback: Use dm-tool to switch to greeter
                        try {
                            GLib.spawn_command_line_async('dm-tool switch-to-greeter');
                            global.log('Ctrl+Alt+Del: User switch attempted via dm-tool');
                        } catch (dmError) {
                            global.log('Ctrl+Alt+Del: All user switch methods failed: ' + dmError);
                        }
                    }
                }
            });
        } else {
            global.log('Ctrl+Alt+Del: Single user system, hiding Switch User button');
        }

        // Sign Out button - use proper logout method
        makeBtn('Sign Out', () => {
            global.log('Ctrl+Alt+Del: Sign Out button clicked');
            this.close();
            try {
                // Primary method: gnome-session-quit (most reliable)
                GLib.spawn_command_line_async('gnome-session-quit --logout --no-prompt');
                global.log('Ctrl+Alt+Del: Logout initiated via gnome-session-quit');
            } catch (e) {
                global.log('Ctrl+Alt+Del: gnome-session-quit failed: ' + e);
                // Fallback: D-Bus method
                try {
                    GLib.spawn_command_line_async('dbus-send --session --type=method_call --dest=org.gnome.SessionManager /org/gnome/SessionManager org.gnome.SessionManager.Logout uint32:1');
                    global.log('Ctrl+Alt+Del: Logout initiated via D-Bus');
                } catch (dbusError) {
                    global.log('Ctrl+Alt+Del: D-Bus logout failed: ' + dbusError);
                    // Final fallback: systemd-logind (get session ID from environment)
                    try {
                        let sessionId = GLib.getenv('XDG_SESSION_ID');
                        if (sessionId) {
                            GLib.spawn_command_line_async('loginctl terminate-session ' + sessionId);
                            global.log('Ctrl+Alt+Del: Logout initiated via loginctl');
                        } else {
                            // If no session ID, use 'self' to terminate current session
                            GLib.spawn_command_line_async('loginctl terminate-session self');
                            global.log('Ctrl+Alt+Del: Logout initiated via loginctl (self)');
                        }
                    } catch (loginctlError) {
                        global.log('Ctrl+Alt+Del: All logout methods failed: ' + loginctlError);
                    }
                }
            }
        });

        // Task Manager button
        makeBtn('Task Manager', () => {
            global.log('Ctrl+Alt+Del: Task Manager button clicked');
            this.close();
            try {
                GLib.spawn_command_line_async('gnome-system-monitor');
                global.log('Ctrl+Alt+Del: Launched system monitor');
            } catch (e) {
                global.log('Ctrl+Alt+Del: System monitor failed, trying alternatives: ' + e);
                try {
                    GLib.spawn_command_line_async('htop');
                } catch (fallbackError) {
                    global.log('Ctrl+Alt+Del: htop also failed: ' + fallbackError);
                }
            }
        });

        // Cancel button
        makeBtn('Cancel', () => {
            global.log('Ctrl+Alt+Del: Cancel button clicked');
            this.close();
        }, 'ctrl-alt-del-button cancel-button');

        global.log('Ctrl+Alt+Del: Dialog created with 5 buttons using proper GNOME Shell layout');
        
        // Connect to key events for ESC, Ctrl+Alt+Del, and arrow keys
        this._keyId = this.actor.connect('key-press-event', (actor, event) => {
            let key = event.get_key_symbol();
            let state = event.get_state();
            let hasCtrl = state & Clutter.ModifierType.CONTROL_MASK;
            let hasAlt = state & Clutter.ModifierType.MOD1_MASK;
            
            // ESC key (0xFF1B)
            if (key === 0xFF1B) {
                global.log('Ctrl+Alt+Del: ESC pressed, closing dialog');
                this.close();
                return true; // Event handled
            }
            
            // Ctrl+Alt+Del: Check for Delete key (0xFF08) with Ctrl+Alt modifiers
            // Also check for other possible Delete key codes
            if (hasCtrl && hasAlt && (key === 0xFF08 || key === 0xFFFF || key === 0x007F)) {
                global.log('Ctrl+Alt+Del: Ctrl+Alt+Del pressed in dialog (key: 0x' + key.toString(16) + '), closing dialog');
                this.close();
                return true; // Event handled
            }
            
            // Arrow key navigation (Up: 0xFF52, Down: 0xFF54)
            if (key === 0xFF52 || key === 0xFF54) {
                let currentFocused = null;
                let currentIndex = -1;
                
                // Find currently focused button
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i].has_focus()) {
                        currentFocused = this._buttonList[i];
                        currentIndex = i;
                        break;
                    }
                }
                
                // If no button focused, focus first button
                if (currentIndex === -1 && this._buttonList.length > 0) {
                    this._buttonList[0].grab_key_focus();
                    return true;
                }
                
                // Navigate up/down
                if (key === 0xFF52) { // Up arrow
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : this._buttonList.length - 1;
                    this._buttonList[newIndex].grab_key_focus();
                } else if (key === 0xFF54) { // Down arrow
                    let newIndex = currentIndex < this._buttonList.length - 1 ? currentIndex + 1 : 0;
                    this._buttonList[newIndex].grab_key_focus();
                }
                
                return true; // Event handled
            }
            
            // Tab key navigation (Tab: 0xFF09, Shift+Tab: 0xFF09 with shift)
            if (key === 0xFF09) {
                let currentFocused = null;
                let currentIndex = -1;
                
                // Find currently focused button
                for (let i = 0; i < this._buttonList.length; i++) {
                    if (this._buttonList[i].has_focus()) {
                        currentFocused = this._buttonList[i];
                        currentIndex = i;
                        break;
                    }
                }
                
                // If no button focused, focus first button
                if (currentIndex === -1 && this._buttonList.length > 0) {
                    this._buttonList[0].grab_key_focus();
                    return true;
                }
                
                // Navigate forward/backward with Tab
                let shiftPressed = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
                if (shiftPressed) { // Shift+Tab: go up
                    let newIndex = currentIndex > 0 ? currentIndex - 1 : this._buttonList.length - 1;
                    this._buttonList[newIndex].grab_key_focus();
                } else { // Tab: go down
                    let newIndex = currentIndex < this._buttonList.length - 1 ? currentIndex + 1 : 0;
                    this._buttonList[newIndex].grab_key_focus();
                }
                
                return true; // Event handled
            }
            
            return false;
        });
    }

    open() {
        // Get primary monitor geometry first
        let display = global.display;
        let primaryMonitor = display.get_primary_monitor();
        let primaryGeometry = display.get_monitor_geometry(primaryMonitor);
        
        // Create black overlays for ALL monitors in uiGroup first
        // This ensures they're visible on all screens before dialog opens
        _createBlackOverlays(Main.uiGroup);
        
        // Force a redraw to ensure overlays are visible
        Main.uiGroup.queue_redraw();

        // ModalDialog creates lightbox automatically + shows dialog
        super.open();

        // Ensure dialog fills the primary screen completely
        this.actor.set_size(primaryGeometry.width, primaryGeometry.height);
        
        // Position dialog on primary monitor
        this.actor.set_position(primaryGeometry.x, primaryGeometry.y);
        
        // CRITICAL: Ensure the lightbox also covers the full primary monitor
        // ModalDialog creates a lightbox actor - we need to find and resize it
        // Search in the dialog's parent group (where ModalDialog typically places the lightbox)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            try {
                let dialogParent = this.actor.get_parent();
                if (dialogParent) {
                    // Search for lightbox in the dialog's parent group
                    let children = dialogParent.get_children();
                    for (let i = 0; i < children.length; i++) {
                        let child = children[i];
                        if (child && child.get_style_class_name) {
                            let className = child.get_style_class_name();
                            if (className && className.includes('lightbox')) {
                                // Ensure lightbox covers full primary monitor
                                child.set_size(primaryGeometry.width + 2, primaryGeometry.height + 2);
                                child.set_position(primaryGeometry.x, primaryGeometry.y);
                                global.log('Ctrl+Alt+Del: Lightbox resized to cover full primary monitor: ' + 
                                          (primaryGeometry.width + 2) + 'x' + (primaryGeometry.height + 2));
                                break;
                            }
                        }
                    }
                }
            } catch (e) {
                global.log('Ctrl+Alt+Del: Could not resize lightbox: ' + e);
            }
            return false; // Don't repeat
        });

        // CRITICAL: Move overlays to dialog's parent group and ensure they cover ALL monitors
        // The dialog's parent group can contain children positioned on any monitor
        // Then raise dialog above overlays for proper z-ordering
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            let display = global.display;
            let dialogParent = this.actor.get_parent();
            
            if (!dialogParent) {
                global.log('Ctrl+Alt+Del: Warning - dialog has no parent');
                return false;
            }
            
            // Move all overlays to the dialog's parent group and ensure they cover all monitors
            for (let i = 0; i < _blackOverlays.length; i++) {let overlay = _blackOverlays[i];
                let currentParent = overlay.get_parent();
                
                // Get fresh monitor geometry to ensure correct size/position (handles dynamic changes)
                let monitorGeometry = display.get_monitor_geometry(i);
                
                // Move overlay to dialog's parent if not already there
                // The dialog's parent group can contain children positioned anywhere on screen
                if (!currentParent) {
                    dialogParent.add_child(overlay);
                } else if (currentParent !== dialogParent) {
                    currentParent.remove_child(overlay);
                    dialogParent.add_child(overlay);
                }
                
                // CRITICAL: Re-set size and position dynamically to ensure full coverage on all monitors
                // This handles monitor geometry changes (resolution, position, etc.)
                // The dialog's parent group allows children to be positioned on any monitor
                overlay.set_size(monitorGeometry.width + 2, monitorGeometry.height + 2);
                overlay.set_position(monitorGeometry.x, monitorGeometry.y);
                overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
                overlay.show(); // Explicitly show the overlay
                overlay.set_opacity(255); // Ensure fully opaque
                
                global.log('Ctrl+Alt+Del: Overlay ' + i + ' positioned at (' + 
                          monitorGeometry.x + ',' + monitorGeometry.y + ') size ' +
                          (monitorGeometry.width + 2) + 'x' + (monitorGeometry.height + 2) + ' in dialog parent');
            }
            
            // CRITICAL: Raise dialog above all overlays in z-order within the same parent
            // This ensures buttons are visible above the black overlays
            if (_blackOverlays.length > 0) {
                try {
                    // Get all children of dialog parent
                    let children = dialogParent.get_children();
                    
                    // Find dialog actor and last overlay
                    let dialogIndex = -1;
                    let lastOverlayIndex = -1;
                    let lastOverlay = null;
                    
                    for (let i = 0; i < children.length; i++) {
                        if (children[i] === this.actor) {
                            dialogIndex = i;
                        }
                        if (_blackOverlays.indexOf(children[i]) >= 0) {
                            lastOverlayIndex = i;
                            lastOverlay = children[i];
                        }
                    }
                    
                    // Raise dialog above the last overlay
                    if (lastOverlay && dialogIndex >= 0) {
                        dialogParent.set_child_above_sibling(this.actor, lastOverlay);
                        global.log('Ctrl+Alt+Del: Raised dialog above overlays in z-order');
                    } else {
                        // Fallback: try to raise dialog to top
                        try {
                            if (children.length > 1) {
                                dialogParent.set_child_above_sibling(this.actor, children[children.length - 1]);
                            }
                        } catch (e) {
                            global.log('Ctrl+Alt+Del: Could not raise dialog: ' + e);
                        }
                    }
                } catch (e) {
                    global.log('Ctrl+Alt+Del: Error adjusting z-order: ' + e);
                }
            }
            
            return false; // Don't repeat
        });

        // Periodically update overlay positions to handle dynamic monitor changes
        // This ensures overlays always cover all monitors even if geometry changes
        let overlayUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            // CRITICAL: Check if this dialog is still the active dialog
            // If not, stop updating and remove overlays
            if (_ctrlAltDelDialog !== this) {
                global.log('Ctrl+Alt+Del: Dialog no longer active, stopping overlay updates');
                _removeBlackOverlays();
                return false; // Stop the periodic update
            }
            
            if (_blackOverlays.length > 0 && this.actor && this.actor.get_parent()) {
                let display = global.display;
                let nMonitors = display.get_n_monitors();
                let dialogParent = this.actor.get_parent();
                
                if (!dialogParent) {
                    return true; // Continue, dialog might not be ready yet
                }
                
                // Update existing overlays or create new ones if monitor count changed
                for (let i = 0; i < nMonitors; i++) {
                    let monitorGeometry = display.get_monitor_geometry(i);
                    
                    if (i < _blackOverlays.length) {
                        // Update existing overlay
                        let overlay = _blackOverlays[i];
                        overlay.set_size(monitorGeometry.width + 2, monitorGeometry.height + 2);
                        overlay.set_position(monitorGeometry.x, monitorGeometry.y);
                        
                        // Ensure it's in dialog's parent
                        if (overlay.get_parent() !== dialogParent) {
                            if (overlay.get_parent()) {
                                overlay.get_parent().remove_child(overlay);
                            }
                            dialogParent.add_child(overlay);
                        }
                    } else {
                        // Create new overlay if monitor was added
                        let overlay = new St.Widget({
                            style_class: 'ctrl-alt-del-black-overlay',
                            x: monitorGeometry.x,
                            y: monitorGeometry.y,
                            width: monitorGeometry.width + 2,
                            height: monitorGeometry.height + 2,
                            reactive: false,
                        });
                        overlay.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 }));
                        dialogParent.add_child(overlay);
                        overlay.show();
                        overlay.set_opacity(255);
                        _blackOverlays.push(overlay);
                    }
                }
                
                // Remove extra overlays if monitors were removed
                while (_blackOverlays.length > nMonitors) {
                    let overlay = _blackOverlays.pop();
                    if (overlay.get_parent()) {
                        overlay.get_parent().remove_child(overlay);
                    }
                    overlay.destroy();
                }
                
                // Ensure dialog is still above overlays after updates
                try {
                    if (_blackOverlays.length > 0) {
                        let lastOverlay = _blackOverlays[_blackOverlays.length - 1];
                        dialogParent.set_child_above_sibling(this.actor, lastOverlay);
                    }
                } catch (e) {
                    // Ignore z-order errors
                }
            }
            return true; // Continue updating
        });
        
        // Store update ID to clean up when dialog closes
        this._overlayUpdateId = overlayUpdateId;

        // Focus first button for keyboard navigation (with small delay to ensure dialog is rendered)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this._buttonList && this._buttonList.length > 0) {
                this._buttonList[0].grab_key_focus();
            }
            return false; // Don't repeat
        });

        global.log('Ctrl+Alt+Del: Dialog opened with black overlays on all monitors');
    }
    
    close() {
        global.log('Ctrl+Alt+Del: Dialog close() called');
        
        // Clean up periodic overlay update FIRST (CRITICAL - stops overlay updates)
        if (this._overlayUpdateId) {
            GLib.source_remove(this._overlayUpdateId);
            this._overlayUpdateId = null;
        }
        
        // Remove black overlays IMMEDIATELY before closing
        // This ensures they're gone before the dialog closes
        _removeBlackOverlays();
        
        // Force a redraw to ensure overlays are removed from display
        if (Main.uiGroup) {
            Main.uiGroup.queue_redraw();
        }
        
        // Also force redraw on dialog's parent if it exists
        try {
            let dialogParent = this.actor ? this.actor.get_parent() : null;
            if (dialogParent) {
                dialogParent.queue_redraw();
            }
        } catch (e) {
            // Ignore errors
        }
        
        // Clean up global reference immediately (before closing)
        // This prevents the polling loop from thinking dialog is still open
        if (_ctrlAltDelDialog === this) {
            _ctrlAltDelDialog = null;
        }
        
        // Reset opening/closing flag to allow new operations
        _isOpeningOrClosing = false;
        
        // Close ModalDialog (this handles lightbox and modal state cleanup)
        // Since destroyOnClose: true, ModalDialog will call destroy() automatically
        super.close();
        
        // Safety: Remove overlays again after close (in case they weren't removed)
        // Use a small timeout to ensure it happens after the close operation
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (_blackOverlays.length > 0) {
                global.log('Ctrl+Alt+Del: Safety cleanup - removing ' + _blackOverlays.length + ' remaining overlays');
                _removeBlackOverlays();
            }
            return false; // Don't repeat
        });
    }
    
    vfunc_destroy() {
        global.log('Ctrl+Alt+Del: Dialog destroy() called');
        
        // Clean up periodic overlay update (CRITICAL - stops overlay updates)
        if (this._overlayUpdateId) {
            GLib.source_remove(this._overlayUpdateId);
            this._overlayUpdateId = null;
        }
        
        // Disconnect key handler
        if (this._keyId) {
            try {
                this.actor.disconnect(this._keyId);
            } catch (e) {
                // Ignore if already disconnected
            }
            this._keyId = null;
        }
        
        // Remove black overlays (CRITICAL - ensure they're gone)
        _removeBlackOverlays();
        
        // Force redraw to ensure overlays are removed
        if (Main.uiGroup) {
            Main.uiGroup.queue_redraw();
        }
        
        // Clean up global reference
        if (_ctrlAltDelDialog === this) {
            _ctrlAltDelDialog = null;
        }
        
        // Call parent destroy
        super.vfunc_destroy();
        
        // Final safety check: Remove any remaining overlays after destroy
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (_blackOverlays.length > 0) {
                global.log('Ctrl+Alt+Del: Final safety cleanup - removing ' + _blackOverlays.length + ' remaining overlays after destroy');
                _removeBlackOverlays();
            }
            return false; // Don't repeat
        });
    }
});

function init() {
    // Extension initialization
}


// Function to handle Ctrl+Alt+Del trigger (called by both global keybinding and file trigger)
function _handleCtrlAltDel() {
    // Don't process if we're in the middle of a lock operation
    if (_isLocking) {
        return;
    }
    
    // Debounce: ignore triggers within 200ms of last toggle
    let currentTime = Date.now();
    if (currentTime - _lastToggleTime < 200) {
        return;
    }
    
    _lastToggleTime = currentTime;
    
    // Check if dialog is already open - if so, close it
    if (_ctrlAltDelDialog) {
        let isActuallyOpen = _ctrlAltDelDialog.actor && 
                           _ctrlAltDelDialog.actor.get_parent() !== null;
        
        if (isActuallyOpen) {
            global.log('Ctrl+Alt+Del: Dialog already open, closing it...');
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
            // Clean up stale reference
            _ctrlAltDelDialog = null;
        }
    }
    
    // Don't open if we're currently opening or closing
    if (_isOpeningOrClosing) {
        return;
    }
    
    // Create and open new dialog
    _isOpeningOrClosing = true;
    try {
        global.log('Ctrl+Alt+Del: Creating new dialog...');
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
    
    // Initialize file-based logging for lock diagnosis
    _initFileLogging();
    _logToFile('Extension enabled');
    _logSystemState('EXTENSION ENABLED');
    
    // Register global keybinding for Ctrl+Alt+Del (system-level, overrides apps)
    // This works regardless of which monitor or application has focus
    try {
        const Meta = imports.gi.Meta;
        
        // Create a simple settings object for the keybinding
        // We'll use a dummy schema or create settings on the fly
        let keybindingSettings = null;
        try {
            // Try to use existing schema or create a simple one
            keybindingSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.ctrl-alt-del' });
        } catch (e) {
            // If schema doesn't exist, we'll fall back to file-based trigger
            // The file-based trigger should work from all monitors
            global.log('Ctrl+Alt+Del: Schema not found, will use file-based trigger (works from all monitors)');
        }
        
        // If we have settings, try to use global.display.add_keybinding
        // Note: This may not work without a proper schema, so we'll fall back to file-based trigger
        try {
            global.display.add_keybinding(
                'ctrl-alt-del',
                keybindingSettings,
                Meta.KeyBindingFlags.NONE,
                () => {
                    global.log('Ctrl+Alt+Del: Global keybinding triggered (system-level)');
                    _handleCtrlAltDel();
                }
            );
            global.log('Ctrl+Alt+Del: Global keybinding registered successfully');
        } catch (e2) {
            global.log('Ctrl+Alt+Del: Could not use global.display.add_keybinding: ' + e2);
            global.log('Ctrl+Alt+Del: Will use file-based trigger (works from all monitors)');
        }
    } catch (e) {
        global.log('Ctrl+Alt+Del: Could not register global keybinding (will use file-based trigger): ' + e);
        // Fall back to file-based trigger if global keybinding fails
    }
    
    // Set up file-based trigger using polling (more reliable, works immediately)
    // This is a fallback and also works with the external script
    _triggerFile = Gio.file_new_for_path(GLib.get_home_dir() + '/.ctrl-alt-del-trigger');
    
    // Poll for trigger file every 50ms for fast response
    // This works from ALL monitors and overrides app shortcuts
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, function() {
        try {
            // Don't open if we're in the middle of a lock operation
            if (_isLocking) {
                return true; // Continue polling
            }
            
            if (_triggerFile && _triggerFile.query_exists(null)) {
                // Delete trigger file immediately
                try {
                    _triggerFile.delete(null);
                } catch (e) {
                    // Ignore delete errors
                }
                
                // Use the centralized handler function
                // This ensures consistent behavior whether triggered by keybinding or file
                _handleCtrlAltDel();
                return true; // Continue polling
            }
            
            // Legacy code below - keeping for backward compatibility but should not be reached
            // if _handleCtrlAltDel() works correctly
            if (false) {  // Disabled - using _handleCtrlAltDel() instead
                // Check if dialog is already open FIRST - if so, close it immediately
                // This allows closing even if _isOpeningOrClosing is true
                if (_ctrlAltDelDialog) {
                    // Verify dialog is actually still in the actor tree
                    let isActuallyOpen = _ctrlAltDelDialog.actor && 
                                       _ctrlAltDelDialog.actor.get_parent() !== null;
                    
                    if (isActuallyOpen) {
                        global.log('Ctrl+Alt+Del: Dialog already open, closing it...');
                        
                        // Delete trigger file immediately
                        try {
                            _triggerFile.delete(null);
                        } catch (e) {
                            global.log('Ctrl+Alt+Del: Error deleting trigger file: ' + e);
                        }
                        
                        try {
                            _ctrlAltDelDialog.close();
                            // Reset flag after a short delay to allow close to complete
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                                _isOpeningOrClosing = false;
                                return false;
                            });
                            return true; // Continue polling
                        } catch (e) {
                            global.log('Ctrl+Alt+Del: Error closing existing dialog: ' + e);
                            // Force cleanup on error
                            try {
                                if (_ctrlAltDelDialog.actor && _ctrlAltDelDialog.actor.get_parent()) {
                                    _ctrlAltDelDialog.actor.get_parent().remove_child(_ctrlAltDelDialog.actor);
                                }
                            } catch (cleanupError) {
                                global.log('Ctrl+Alt+Del: Cleanup error: ' + cleanupError);
                            }
                            _ctrlAltDelDialog = null;
                            _isOpeningOrClosing = false; // Reset flag immediately on error
                            return true; // Continue polling
                        }
                    } else {
                        // Dialog reference exists but dialog is not actually open - clean up stale reference
                        global.log('Ctrl+Alt+Del: Stale dialog reference found, cleaning up...');
                        _ctrlAltDelDialog = null;
                        _isOpeningOrClosing = false; // Reset flag
                        // Continue to create new dialog below
                    }
                }
                
                // Don't process if we're currently opening or closing (prevents rapid toggling)
                // But only if we're not closing an existing dialog (handled above)
                if (_isOpeningOrClosing) {
                    // Delete trigger file but ignore it
                    try {
                        _triggerFile.delete(null);
                    } catch (e) {
                        // Ignore delete errors
                    }
                    return true; // Continue polling, wait for current operation to complete
                }
                
                // Set flag to prevent rapid toggling
                _isOpeningOrClosing = true;
                _lastToggleTime = currentTime;
                
                // Delete trigger file immediately to prevent duplicate processing
                try {
                    _triggerFile.delete(null);
                } catch (e) {
                    global.log('Ctrl+Alt+Del: Error deleting trigger file: ' + e);
                }
                
                // If we reach here, no dialog exists - create and open a new dialog
                global.log('Ctrl+Alt+Del: Trigger file detected, creating screen...');

                // Create dialog with black backdrop covering all monitors
                global.log('Ctrl+Alt+Del: Creating new dialog instance with black backdrop...');
                try {
                    _ctrlAltDelDialog = new CtrlAltDelDialog();
                    global.log('Ctrl+Alt+Del: Dialog created successfully');
                } catch (e) {
                    Main.notify('Ctrl+Alt+Del ERROR', 'Failed to create dialog: ' + e);
                    global.log('Ctrl+Alt+Del ERROR creating dialog: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
                    _isOpeningOrClosing = false; // Reset flag on error
                    return true; // Continue polling
                }

                // Open the dialog (it will be above overlays since created after)
                global.log('Ctrl+Alt+Del: Opening dialog...');
                try {
                    _ctrlAltDelDialog.open();
                    global.log('Ctrl+Alt+Del: Dialog.open() called successfully');
                    
                    // Reset flag after dialog is opened
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        _isOpeningOrClosing = false;
                        return false;
                    });
                } catch (e) {
                    Main.notify('Ctrl+Alt+Del ERROR', 'Failed to open dialog: ' + e);
                    global.log('Ctrl+Alt+Del ERROR opening dialog: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
                    _ctrlAltDelDialog = null;
                    _isOpeningOrClosing = false; // Reset flag on error
                    return true; // Continue polling
                }

                global.log('Ctrl+Alt+Del: Dialog opened with black backdrop covering all monitors');
                return true; // Continue polling
            }
        } catch (e) {
            Main.notify('Ctrl+Alt+Del ERROR', String(e));
            global.log('Ctrl+Alt+Del ERROR: ' + e + ' | Stack: ' + (e.stack || 'no stack'));
        }
        return true; // Continue polling
    });
    
    global.log('Ctrl+Alt+Del: Polling started');
}

function disable() {
    global.log('Ctrl+Alt+Del: Extension disabled!');
    
    // CRITICAL: Remove all overlays when extension is disabled
    _removeBlackOverlays();
    
    // Close and destroy any open dialog
    _logToFile('Extension disabled');
    _flushLogBuffer();
    
    if (_ctrlAltDelDialog) {
        _ctrlAltDelDialog.destroy();
        _ctrlAltDelDialog = null;
    }
    _removeBlackOverlays();
    delete global.showCtrlAltDelDialog;
    _triggerFile = null;
    
    // Clean up logging
    if (_logFlushTimeoutId) {
        GLib.source_remove(_logFlushTimeoutId);
        _logFlushTimeoutId = null;
    }
    _flushLogBuffer(); // Final flush
    
    // Close primary log stream
    if (_logFileStream) {
        try {
            _logFileStream.close(null);
        } catch (e) {
            global.log('Ctrl+Alt+Del: Error closing primary log file: ' + e);
        }
        _logFileStream = null;
    }
    
    // Close backup log stream
    if (_logBackupFileStream) {
        try {
            _logBackupFileStream.close(null);
        } catch (e) {
            global.log('Ctrl+Alt+Del: Error closing backup log file: ' + e);
        }
        _logBackupFileStream = null;
    }
    
    _logFile = null;
    _logBackupFile = null;
    _logBuffer = '';
}


