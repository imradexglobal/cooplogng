import { showToast } from '../services/toastService.js'

/**
 * Shared image picker — 100% OFFLINE.
 * No network calls, no CDN, no cloud upload. Everything is local:
 * - In-app camera  -> navigator.mediaDevices.getUserMedia (device hardware, offline)
 * - Native camera  -> <input capture> fires the OS camera app (offline)
 * - Gallery        -> <input type=file> opens the OS file/gallery chooser (offline)
 * All paths resolve to a local File, so existing compressImage(file) flows
 * work unchanged on web, APK and Electron without internet.
 */

export function isInAppCameraSupported() {
    try {
        if (!navigator.mediaDevices?.getUserMedia) return false
        // getUserMedia needs a secure context (https, localhost, file://,
        // Capacitor http://localhost). Plain-LAN http has no mediaDevices, so
        // we report false and the picker falls back to the native camera app
        // (which works everywhere, offline). We NEVER hide the camera option.
        if (typeof window !== 'undefined' && window.isSecureContext === false) return false
        return true
    } catch {
        return false
    }
}

function _singleFileInput({ capture = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        if (capture) input.setAttribute('capture', 'environment')
        input.style.display = 'none'
        // capture attr must be set before click on some Android WebViews
        document.body.appendChild(input)
        let settled = false
        const done = (file) => {
            if (settled) return
            settled = true
            try { window.removeEventListener('focus', onFocus) } catch {}
            try { input.remove() } catch {}
            resolve(file || null)
        }
        input.addEventListener('change', () => done(input.files?.[0] || null), { once: true })
        // Modern browsers (Chrome 113+, Firefox, Safari) fire `cancel` when
        // the user dismisses the chooser without picking. Resolve promptly.
        try {
            input.addEventListener('cancel', () => done(null), { once: true })
        } catch {}
        // Some browsers fire no cancel event when the user backs out of the
        // picker. Resolve null shortly after focus returns, but ONLY if the
        // user really picked nothing (avoids premature cancel on slow devices).
        const onFocus = () => {
            setTimeout(() => {
                if (!settled && (!input.files || input.files.length === 0)) {
                    done(null)
                }
            }, 800)
        }
        window.addEventListener('focus', onFocus)
        // Extra safety: if change/cancel never fire and focus never returns
        // (some custom ROMs, or a blocked file chooser), don't leave a
        // dangling promise/input. Always clean up and resolve null.
        setTimeout(() => {
            if (!settled && (!input.files || input.files.length === 0)) {
                done(null)
            }
        }, 60000)
        try {
            input.click()
        } catch {
            done(null)
        }
    })
}

function _pickFromGallery() {
    return _singleFileInput({ capture: false })
}

function _pickFromCameraApp() {
    return _singleFileInput({ capture: true })
}

/**
 * Fallback sheet shown AFTER the in-app camera fails.
 * Why this exists: Chrome requires a live user activation to open the file
 * chooser ("File chooser dialog can only be shown with a user activation").
 * The original "Take photo" tap is long gone by the time getUserMedia
 * rejects (async gap + a second modal), so calling input.click()
 * programmatically here is blocked and the promise would hang. This sheet
 * gives the user a fresh button to tap, restoring activation.
 */
function _showCameraAppFallback(done, errName = '') {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay open'
    overlay.innerHTML = `
      <div class="modal-content" style="max-width: 340px; padding: 1.25rem; text-align: center;">
        <h3 style="margin: 0 0 0.25rem 0;">Camera unavailable</h3>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem 0;">${errName === 'NotAllowedError' || errName === 'SecurityError'
            ? 'Camera access was blocked. You can use your camera app instead — tap below.'
            : 'Could not start the in-app camera. You can use your camera app instead — tap below.'}</p>
        <div style="display: flex; flex-direction: column; gap: 0.6rem;">
            <button class="primary-button" id="pp-native-cam" style="min-height: 3rem;">Open camera app</button>
            <button class="ghost-button" id="pp-fb-cancel" style="color: var(--text-muted);">Cancel</button>
        </div>
      </div>`
    const close = () => overlay.remove()
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); done(null) } })
    overlay.querySelector('#pp-fb-cancel')?.addEventListener('click', () => { close(); done(null) })
    // This click() runs synchronously inside a real user gesture, so the
    // file chooser is allowed. Awaiting inside keeps activation alive.
    overlay.querySelector('#pp-native-cam')?.addEventListener('click', async () => {
        close()
        done(await _pickFromCameraApp())
    })
    document.body.appendChild(overlay)
}

function _stopStream(stream) {
    try {
        stream?.getTracks()?.forEach(t => { try { t.stop() } catch {} })
    } catch {}
}

/**
 * In-app camera: live preview -> Capture -> preview -> Use/Retake.
 * Uses only device hardware (offline). Resolves a JPEG File on
 * "Use photo", null on cancel/close.
 * THROWS on camera startup failure (permission denied, no device) so the
 * caller can fall back to the native camera intent (also offline).
 */
export function capturePhoto() {
    return new Promise((resolve, reject) => {
        let settled = false
        let stream = null
        let facing = 'environment'
        let videoDevices = []

        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay open'
        overlay.innerHTML = `
          <div class="modal-content" style="max-width: 420px; padding: 1rem; text-align: center;">
            <h3 style="margin: 0 0 0.75rem 0;">Take photo</h3>
            <div id="pp-view" style="position: relative; background: #000; border-radius: 0.75rem; overflow: hidden;">
              <video id="pp-video" playsinline autoplay muted
                style="width: 100%; max-height: 55vh; display: block; object-fit: cover; background: #000;"></video>
              <img id="pp-still" style="display: none; width: 100%; max-height: 55vh; object-fit: contain; background: #000;" />
              <div id="pp-status" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.85rem;">Starting camera…</div>
            </div>
            <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0.6rem 0 0 0;">Works offline — photo never leaves this device until you save.</p>
            <div style="display: flex; gap: 0.6rem; margin-top: 1rem;">
              <button class="ghost-button" id="pp-close" style="flex: 1;">Cancel</button>
              <button class="secondary-button" id="pp-flip" style="flex: 1; display: none; min-height: 2.75rem;">Flip</button>
              <button class="primary-button" id="pp-shoot" style="flex: 1; min-height: 2.75rem;" disabled>Capture</button>
            </div>
            <div style="display: none; gap: 0.6rem; margin-top: 1rem;" id="pp-confirm-row">
              <button class="secondary-button" id="pp-retake" style="flex: 1; min-height: 2.75rem;">Retake</button>
              <button class="primary-button" id="pp-use" style="flex: 1; min-height: 2.75rem;">Use photo</button>
            </div>
          </div>`

        const finish = (file) => {
            if (settled) return
            settled = true
            _stopStream(stream)
            overlay.remove()
            resolve(file || null)
        }
        const fail = (err) => {
            if (settled) return
            settled = true
            _stopStream(stream)
            overlay.remove()
            reject(err)
        }

        const video = overlay.querySelector('#pp-video')
        const still = overlay.querySelector('#pp-still')
        const status = overlay.querySelector('#pp-status')
        const shootBtn = overlay.querySelector('#pp-shoot')
        const flipBtn = overlay.querySelector('#pp-flip')
        const confirmRow = overlay.querySelector('#pp-confirm-row')
        const actionRow = shootBtn.parentElement

        const showLive = () => {
            still.style.display = 'none'
            video.style.display = 'block'
            confirmRow.style.display = 'none'
            actionRow.style.display = 'flex'
        }

        const start = async () => {
            _stopStream(stream)
            status.style.display = 'flex'
            status.textContent = 'Starting camera…'
            shootBtn.disabled = true
            try {
                // Local hardware only — no network involved.
                const constraints = facing === 'environment'
                    ? { video: { facingMode: { ideal: 'environment' } }, audio: false }
                    : { video: { deviceId: { exact: facing } }, audio: false }
                stream = await navigator.mediaDevices.getUserMedia(constraints)
            } catch (err) {
                fail(err)
                return
            }
            video.srcObject = stream
            try { await video.play() } catch {}
            status.style.display = 'none'
            shootBtn.disabled = false
            try {
                const devices = await navigator.mediaDevices.enumerateDevices()
                videoDevices = devices.filter(d => d.kind === 'videoinput')
                flipBtn.style.display = videoDevices.length > 1 ? '' : 'none'
            } catch {
                flipBtn.style.display = 'none'
            }
        }

        flipBtn.addEventListener('click', async () => {
            if (videoDevices.length < 2 || !stream) return
            const currentId = stream.getVideoTracks()[0]?.getSettings?.().deviceId
            const next = videoDevices.find(d => d.deviceId && d.deviceId !== currentId) || videoDevices[0]
            facing = next.deviceId || 'environment'
            await start()
        })

        shootBtn.addEventListener('click', () => {
            if (!video.videoWidth) return
            const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
            const canvas = document.createElement('canvas')
            canvas.width = Math.round(video.videoWidth * scale)
            canvas.height = Math.round(video.videoHeight * scale)
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
            canvas.toBlob((blob) => {
                if (!blob) {
                    showToast('Could not capture. Try again.', 'error')
                    return
                }
                still.src = URL.createObjectURL(blob)
                still.style.display = 'block'
                video.style.display = 'none'
                actionRow.style.display = 'none'
                confirmRow.style.display = 'flex'
                overlay.querySelector('#pp-use').onclick = () => {
                    const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })
                    finish(file)
                }
            }, 'image/jpeg', 0.92)
        })

        overlay.querySelector('#pp-retake').addEventListener('click', showLive)
        overlay.querySelector('#pp-close').addEventListener('click', () => finish(null))
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null) })

        document.body.appendChild(overlay)
        start()
    })
}

/**
 * Source picker modal: "Take photo" + "Choose from gallery" + Cancel.
 * Camera option is ALWAYS shown — on devices without in-app camera support
 * it opens the native camera app directly (offline). Resolves a File,
 * or null when cancelled. No internet required at any step.
 */
export async function pickImageFile({ title = 'Add photo' } = {}) {
    const inApp = isInAppCameraSupported()
    return new Promise((resolve) => {
        let settled = false
        const done = (file) => {
            if (settled) return
            settled = true
            resolve(file || null)
        }
        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay open'
        overlay.innerHTML = `
          <div class="modal-content" style="width:calc(100% - 2rem); max-width:340px; padding:1rem; text-align:center; box-sizing:border-box;">
            <h3 style="margin: 0 0 0.25rem 0;">${title}</h3>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem 0;">Camera or gallery — works offline.</p>
            <div style="display:flex;flex-direction:column;align-items:center;gap:0.5rem;">
                <button class="primary-button" id="pp-camera" style="width:min(100%,220px);min-height:2.5rem;height:2.5rem;padding:0.5rem 0.85rem;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:0.5rem;flex:none;font-size:0.9rem;">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                  Take photo
                </button>
                <button class="secondary-button" id="pp-gallery" style="width:min(100%,220px);min-height:2.5rem;height:2.5rem;padding:0.5rem 0.85rem;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:0.5rem;flex:none;font-size:0.9rem;">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M21 15l-5-5L5 21"/></svg>
                  Choose from gallery
                </button>
                <button class="ghost-button" id="pp-cancel" style="min-height:2rem;padding:0.35rem 0.75rem;color:var(--text-muted);">Cancel</button>
            </div>
          </div>`
        const close = () => overlay.remove()
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); done(null) } })
        overlay.querySelector('#pp-cancel')?.addEventListener('click', () => { close(); done(null) })
        overlay.querySelector('#pp-gallery')?.addEventListener('click', async () => {
            close()
            done(await _pickFromGallery())
        })
        overlay.querySelector('#pp-camera')?.addEventListener('click', async () => {
            close()
            if (inApp) {
                let file = null
                try {
                    file = await capturePhoto()
                } catch (err) {
                    console.warn('[PhotoPicker] In-app camera failed, showing camera-app fallback (offline):', err?.name || err?.message)
                    const name = err?.name || ''
                    if (name === 'NotAllowedError' || name === 'SecurityError') {
                        showToast('Camera blocked — tap below to use the camera app.', 'warning')
                    } else if (name === 'AbortError') {
                        showToast('Camera was interrupted — tap below to try the camera app.', 'warning')
                    } else {
                        showToast('In-app camera unavailable — tap below for the camera app.', 'warning')
                    }
                    // Do NOT call input.click() here: transient activation has
                    // expired and Chrome would block it. Show a sheet so the
                    // next input.click() runs inside a fresh user gesture.
                    _showCameraAppFallback(done, name)
                    return
                }
                // User cancelled the in-app camera (resolved null): do NOT
                // auto-open another chooser — that would also lack activation.
                // Just finish; they can tap again if they want the camera app.
                done(file)
                return
            }
            // Default on non-secure contexts / older WebViews: this click()
            // runs synchronously inside the user's tap, so activation is valid.
            done(await _pickFromCameraApp())
        })
        document.body.appendChild(overlay)
    })
}
