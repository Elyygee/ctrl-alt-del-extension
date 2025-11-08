# Why Changes Break the Extension

## Common Issues That Break GNOME Shell Extensions

### 1. **JavaScript Syntax Compatibility (GNOME 42)**
GNOME 42 uses an older JavaScript engine that doesn't support:
- **Optional chaining (`?.`)** - Use `(obj && obj.property)` instead
- **Nullish coalescing (`??`)** - Use `||` instead
- **Arrow functions in some contexts** - Use `function()` instead

**Example:**
```javascript
// ❌ BREAKS in GNOME 42
const modalGroup = Main.layoutManager?.modalDialogGroup || this.actor.get_parent();

// ✅ WORKS in GNOME 42
const modalGroup = (Main.layoutManager && Main.layoutManager.modalDialogGroup) || this.actor.get_parent();
```

### 2. **API Availability by GNOME Version**
Different GNOME versions have different APIs:

- **GNOME 42**: No `monitors-changed` signal on `global.display`
- **GNOME 45+**: Has `monitors-changed` signal

**Solution:** Check API availability before using:
```javascript
// ❌ BREAKS in GNOME 42
_monitorsChangedId = global.display.connect('monitors-changed', () => {...});

// ✅ WORKS - Check if signal exists
if (global.display.connect && typeof global.display.connect === 'function') {
    try {
        _monitorsChangedId = global.display.connect('monitors-changed', () => {...});
    } catch (e) {
        // Signal doesn't exist, skip it
    }
}
```

### 3. **Extension Caching**
GNOME Shell caches extensions. Changes don't take effect until:
- **Restart GNOME Shell**: Alt+F2, type 'r', Enter
- **OR** Disable and re-enable the extension

**Always restart after making changes!**

### 4. **Syntax Errors Break Everything**
A single syntax error can break the entire extension:
- Missing semicolons (sometimes)
- Unclosed brackets `{}` or parentheses `()`
- Typos in variable names
- Missing commas in objects/arrays

**Check syntax before restarting:**
```bash
# Check for syntax errors
node --check extension.js  # Won't catch GNOME-specific APIs, but catches basic syntax
```

### 5. **CSS File Must Exist**
If `stylesheet.css` is empty or missing, CSS changes won't work. The file must exist and be valid CSS.

### 6. **Signal Connection/Disconnection**
Always disconnect signals in `disable()`:
```javascript
// In enable()
_mySignalId = someObject.connect('signal-name', callback);

// In disable() - MUST disconnect
if (_mySignalId) {
    someObject.disconnect(_mySignalId);
    _mySignalId = null;
}
```

### 7. **Actor Lifecycle**
Actors must be properly destroyed:
- Remove from parent before destroying
- Disconnect signals before destroying
- Set references to `null` after destroying

## Safe Modification Workflow

1. **Make small, incremental changes**
2. **Test syntax** (if possible)
3. **Restart GNOME Shell** (Alt+F2, 'r')
4. **Check extension state**: `gnome-extensions info ctrl-alt-del@local`
5. **Check logs**: `journalctl --user -n 50 | grep -i "ctrl-alt-del"`
6. **Test functionality**

## Current Working Code Characteristics

The current code works because:
- ✅ Uses GNOME 42-compatible syntax (no optional chaining)
- ✅ Handles missing APIs gracefully
- ✅ Properly cleans up resources
- ✅ Uses stable, well-tested APIs

## What NOT to Change Without Care

- **ModalDialog API usage** - Very version-specific
- **Signal names** - Must match exactly
- **Actor hierarchy** - Must match GNOME Shell's expectations
- **Key symbol constants** - Use hex values (0xFF0D) not Clutter.KEY_* in some contexts
- **Layout managers** - Must be compatible with version

## Debugging Tips

1. **Check extension state:**
   ```bash
   gnome-extensions info ctrl-alt-del@local
   ```

2. **View error logs:**
   ```bash
   journalctl --user -f | grep -i "ctrl-alt-del\|error"
   ```

3. **Test in Looking Glass:**
   - Alt+F2, type `lg`, Enter
   - Check for JavaScript errors

4. **Incremental testing:**
   - Make one change at a time
   - Test after each change
   - Revert if it breaks

