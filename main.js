const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// GPU 加速を活かす（disable-gpu は CPU レンダリングになり逆効果）
// app.commandLine.appendSwitch('disable-gpu-cache')  ← 削除
// app.commandLine.appendSwitch('disable-gpu')        ← 削除

const PROJECTS_FILE        = path.join(app.getPath('userData'), 'projects.json')
const PROJECT_ICONS_FILE     = path.join(app.getPath('userData'), 'projectIcons.json')
const PROJECT_OVERRIDES_FILE = path.join(app.getPath('userData'), 'projectOverrides.json')
const WINDOW_STATE_FILE    = path.join(app.getPath('userData'), 'windowState.json')
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_DEBUG_DIR     = path.join(os.homedir(), '.claude', 'debug')

let mainWindow   = null
let tray         = null
let saveTimer    = null
let normalBounds = null  // 最大化前の通常サイズをメモリで保持

// ---- インメモリキャッシュ（毎回ディスク読み込みを回避） ----
let projectsCache       = null
let projectIconsCache     = null
let projectOverridesCache = null
let claudeSettingsCache = null
let usageStatsCache     = null

// ---- ウィンドウ状態 ----
function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'))
    state.width  = Math.max(360, state.width  || 480)
    state.height = Math.max(400, state.height || 660)
    if (state.x !== undefined && state.y !== undefined) {
      const onScreen = screen.getAllDisplays().some(d => {
        const b = d.workArea
        return state.x >= b.x - 80 && state.y >= b.y - 80 &&
               state.x <  b.x + b.width && state.y < b.y + b.height
      })
      if (!onScreen) { delete state.x; delete state.y }
    }
    return state
  } catch {
    return { width: 480, height: 660 }
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // normalBounds をメモリから使う（ディスク再読み込みなし）
  const data = { ...(normalBounds || {}), maximized: mainWindow.isMaximized() }
  fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(data, null, 2))
}

function debouncedSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWindowState, 600)
}

// ---- プロジェクト（キャッシュ付き） ----
function loadProjects() {
  if (projectsCache !== null) return projectsCache
  try {
    projectsCache = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'))
  } catch {
    projectsCache = []
  }
  return projectsCache
}

function saveProjects(projects) {
  projectsCache = projects  // キャッシュ更新
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2))
}

// ---- プロジェクトアイコン（キャッシュ付き） ----
function loadProjectIcons() {
  if (projectIconsCache !== null) return projectIconsCache
  try {
    projectIconsCache = JSON.parse(fs.readFileSync(PROJECT_ICONS_FILE, 'utf8'))
  } catch {
    projectIconsCache = {}
  }
  return projectIconsCache
}

function saveProjectIcons(icons) {
  projectIconsCache = icons
  fs.writeFileSync(PROJECT_ICONS_FILE, JSON.stringify(icons, null, 2))
}

// ---- プロジェクトボタンオーバーライド（キャッシュ付き） ----
function loadProjectOverrides() {
  if (projectOverridesCache !== null) return projectOverridesCache
  try {
    projectOverridesCache = JSON.parse(fs.readFileSync(PROJECT_OVERRIDES_FILE, 'utf8'))
  } catch {
    projectOverridesCache = {}
  }
  return projectOverridesCache
}

function saveProjectOverrides(overrides) {
  projectOverridesCache = overrides
  fs.writeFileSync(PROJECT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2))
}

// ---- Claude 設定（キャッシュ付き） ----
function loadClaudeSettings() {
  if (claudeSettingsCache !== null) return claudeSettingsCache
  try {
    claudeSettingsCache = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8') || '{}')
  } catch {
    claudeSettingsCache = {}
  }
  return claudeSettingsCache
}

function saveClaudeSettings(settings) {
  claudeSettingsCache = settings  // キャッシュ更新
  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

// ---- 起動 ----
function launchClaude(folderPath, model, skipPermissions) {
  let cmd = model ? `claude --model ${model}` : 'claude'
  if (skipPermissions) cmd += ' --dangerously-skip-permissions'
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', cmd], {
      detached: true, stdio: 'ignore', cwd: folderPath
    }).unref()
  } else {
    spawn('bash', ['-c', cmd], {
      detached: true, stdio: 'ignore', cwd: folderPath
    }).unref()
  }
}

function createWindow() {
  const state = loadWindowState()
  normalBounds = { x: state.x, y: state.y, width: state.width || 480, height: state.height || 660 }

  mainWindow = new BrowserWindow({
    width:     normalBounds.width,
    height:    normalBounds.height,
    x:         normalBounds.x,
    y:         normalBounds.y,
    minWidth:  360,
    minHeight: 400,
    resizable: true,
    frame:     false,
    show:      false,   // ready-to-show まで非表示（チラつき防止）
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
      backgroundThrottling: false  // 最小化中も処理を止めない
    },
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, 'assets', 'icon.png')
  })

  mainWindow.loadFile('index.html')

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('maximize',   () => mainWindow.webContents.send('window-maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized', false))

  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) { normalBounds = mainWindow.getBounds(); debouncedSave() }
  })
  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) { normalBounds = mainWindow.getBounds(); debouncedSave() }
  })

  mainWindow.on('close',  () => saveWindowState())
  mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Claude Launcher')

  const updateMenu = () => {
    const projects = loadProjects()          // キャッシュから取得
    const settings = loadClaudeSettings()   // キャッシュから取得
    const model = settings.model || null

    const projectItems = projects.map(p => ({
      label: path.basename(p) || p,
      click: () => launchClaude(p, model)
    }))

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Claude Launcher', enabled: false },
      { type: 'separator' },
      ...(projectItems.length > 0
        ? projectItems
        : [{ label: 'プロジェクト未登録', enabled: false }]),
      { type: 'separator' },
      { label: 'ウィンドウを開く', click: () => {
          if (!mainWindow) createWindow()
          else { mainWindow.show(); mainWindow.focus() }
      }},
      { label: '終了', click: () => app.quit() }
    ])
    tray.setContextMenu(contextMenu)
  }

  updateMenu()
  tray.on('double-click', () => {
    if (!mainWindow) createWindow()
    else { mainWindow.show(); mainWindow.focus() }
  })

  ipcMain.on('projects-updated', updateMenu)
}

app.whenReady().then(() => {
  createWindow()
  createTray()
})

app.on('window-all-closed', (e) => e.preventDefault())

// ---- IPC handlers ----
ipcMain.handle('get-projects', () => loadProjects())

ipcMain.handle('get-project-icons', () => loadProjectIcons())

ipcMain.handle('set-project-icon', (_, projPath, icon) => {
  const icons = loadProjectIcons()
  if (!icon || icon === '📁') delete icons[projPath]
  else icons[projPath] = icon
  saveProjectIcons(icons)
  return true
})

ipcMain.handle('get-project-overrides', () => loadProjectOverrides())

ipcMain.handle('set-project-overrides', (_, projPath, overrides) => {
  const all = loadProjectOverrides()
  if (!overrides || Object.keys(overrides).length === 0) delete all[projPath]
  else all[projPath] = overrides
  saveProjectOverrides(all)
  return true
})

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'プロジェクトフォルダを選択'
  })
  if (result.canceled) return null
  const folderPath = result.filePaths[0]
  const projects = loadProjects()
  if (!projects.includes(folderPath)) {
    projects.push(folderPath)
    saveProjects(projects)
    mainWindow.webContents.send('projects-updated')
    ipcMain.emit('projects-updated')
  }
  return folderPath
})

ipcMain.handle('remove-project', (_, folderPath) => {
  saveProjects(loadProjects().filter(p => p !== folderPath))
  ipcMain.emit('projects-updated')
  return true
})

ipcMain.handle('launch-claude', (_, folderPath, model, skipPermissions) => {
  launchClaude(folderPath, model, skipPermissions)
  return true
})

ipcMain.handle('select-and-launch', async (_, model, skipPermissions) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'フォルダを選択してClaude Codeを起動'
  })
  if (result.canceled) return false
  launchClaude(result.filePaths[0], model, skipPermissions)
  return true
})

ipcMain.handle('open-explorer', (_, folderPath) => {
  shell.openPath(folderPath)
  return true
})

ipcMain.handle('launch-vscode', (_, folderPath) => {
  spawn('code', [folderPath], { shell: true, detached: true }).unref()
  return true
})

ipcMain.handle('reorder-projects', (_, newOrder) => {
  saveProjects(newOrder)
  ipcMain.emit('projects-updated')
  return true
})

ipcMain.handle('get-claude-settings', () => loadClaudeSettings())

ipcMain.handle('set-model', (_, model) => {
  const settings = loadClaudeSettings()
  if (model) settings.model = model
  else delete settings.model
  saveClaudeSettings(settings)
  return true
})

// 使用量統計（プロセス起動中はキャッシュ）
ipcMain.handle('get-usage-stats', async () => {
  if (usageStatsCache !== null) return usageStatsCache
  let input = 0, output = 0, sessions = 0
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    const files = await fs.promises.readdir(CLAUDE_DEBUG_DIR)
    await Promise.all(
      files.filter(f => f.endsWith('.txt')).map(async file => {
        const fp = path.join(CLAUDE_DEBUG_DIR, file)
        const stat = await fs.promises.stat(fp)
        if (stat.mtimeMs < cutoff) return
        sessions++
        const content = await fs.promises.readFile(fp, 'utf8')
        for (const m of content.matchAll(/totalUsage: input=(\d+) output=(\d+)/g)) {
          input += parseInt(m[1])
          output += parseInt(m[2])
        }
      })
    )
  } catch { /* debug dir missing */ }
  usageStatsCache = { input, output, sessions }
  return usageStatsCache
})

ipcMain.handle('get-security-status', () => {
  const settings = loadClaudeSettings()
  const denyCount = (settings.permissions?.deny || []).length
  const hasHook   = Array.isArray(settings.hooks?.PreToolUse) && settings.hooks.PreToolUse.length > 0
  return { denyCount, hasHook }
})

ipcMain.handle('open-url', (_, url) => {
  shell.openExternal(url)
  return true
})

ipcMain.handle('launch-app', (_, folderPath, cmd) => {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', cmd], {
      detached: true, stdio: 'ignore', cwd: folderPath
    }).unref()
  } else {
    spawn('bash', ['-c', cmd], {
      detached: true, stdio: 'ignore', cwd: folderPath
    }).unref()
  }
  return true
})

ipcMain.handle('launch-electron-app', (_, folderPath) => {
  const exePath = path.join(folderPath, 'node_modules', 'electron', 'dist', 'electron.exe')
  spawn(exePath, [folderPath], {
    detached: true, stdio: 'ignore', cwd: folderPath
  }).unref()
  return true
})

ipcMain.on('close-window',    () => mainWindow?.hide())
ipcMain.on('minimize-window', () => mainWindow?.minimize())
ipcMain.on('toggle-maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
