    /* State */
    let trackList = [];        // Raw list of audio File objects
    let shuffledIndices = [];  // Permutation array of indices
    let currentIndex = -1;     // Current position in shuffledIndices
    let currentObjectUrl = null;
    let previousObjectUrl = null; // Deferred revocation to avoid decoder cut-off
    let standbyObjectUrl = null;
    let standbyFileIndex = null;
    let isUserSeeking = false;
    let isTransitioning = false; // Lock to prevent double-skipping
    let isPlaying = false;       // Tracks playback intent for background continuity
    let lastVolume = 0.8;
    let audioCtx = null;         // Web Audio keep-alive context for background tabs
    let loadGeneration = 0;      // Ignore stale ID3 / canplay from skipped tracks
    let lastSkipAt = 0;
    let transitionTimer = null;

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function revokeAllObjectUrls() {
      if (previousObjectUrl) { URL.revokeObjectURL(previousObjectUrl); previousObjectUrl = null; }
      if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
      if (standbyObjectUrl) { URL.revokeObjectURL(standbyObjectUrl); standbyObjectUrl = null; }
      standbyFileIndex = null;
      if (typeof standbyEngine !== 'undefined' && standbyEngine) {
        standbyEngine.removeAttribute('src');
        standbyEngine.load();
      }
    }

    function requestSkip(reason) {
      const now = Date.now();
      if (now - lastSkipAt < 600) return;
      lastSkipAt = now;
      playNext();
    }

    function setTransitioning(on) {
      isTransitioning = on;
      if (transitionTimer) clearTimeout(transitionTimer);
      if (on) {
        transitionTimer = setTimeout(() => { isTransitioning = false; }, 4000);
      }
    }

    function peekNextFileIndex() {
      if (trackList.length === 0) return null;
      if (currentIndex + 1 < shuffledIndices.length) {
        return shuffledIndices[currentIndex + 1];
      }
      return null; // wrap requires a new shuffle first
    }

    function preloadStandby() {
      const nextFi = peekNextFileIndex();
      if (nextFi === null) return;
      if (standbyFileIndex === nextFi && standbyEngine && standbyEngine.src) return;
      if (standbyObjectUrl) {
        URL.revokeObjectURL(standbyObjectUrl);
        standbyObjectUrl = null;
      }
      const file = trackList[nextFi];
      if (!file) return;
      standbyObjectUrl = URL.createObjectURL(file);
      standbyFileIndex = nextFi;
      standbyEngine.src = standbyObjectUrl;
      standbyEngine.volume = audioEngine.volume;
      standbyEngine.load();
    }

    function swapEngines() {
      const tmp = audioEngine;
      audioEngine = standbyEngine;
      standbyEngine = tmp;
      const tmpUrl = currentObjectUrl;
      currentObjectUrl = standbyObjectUrl;
      previousObjectUrl = tmpUrl;
      standbyObjectUrl = null;
      standbyFileIndex = null;
      standbyEngine.pause();
      // keep previous blob until the new deck is clearly playing
    }

    /* DOM Elements */
    const folderPicker = document.getElementById('folderPicker');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const coverOverlayBtn = document.getElementById('coverOverlayBtn');
    const folderBtnText = document.getElementById('folderBtnText');
    let audioEngine = document.getElementById('audioEngineA');
    let standbyEngine = document.getElementById('audioEngineB');
    const prevBtn = document.getElementById('prevBtn');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const fwdBtn = document.getElementById('fwdBtn');
    const reshuffleBtn = document.getElementById('reshuffleBtn');
    const togglePlaylistBtn = document.getElementById('togglePlaylistBtn');
    const seekSlider = document.getElementById('seekSlider');
    const currentTimeEl = document.getElementById('currentTime');
    const totalDurationEl = document.getElementById('totalDuration');
    const trackTitle = document.getElementById('trackTitle');
    const trackArtist = document.getElementById('trackArtist');
    const trackAlbum = document.getElementById('trackAlbum');
    const coverArt = document.getElementById('coverArt');
    const coverPlaceholder = document.getElementById('coverPlaceholder');
    const counterDisplay = document.getElementById('counterDisplay');
    const volumeSlider = document.getElementById('volumeSlider');
    const muteBtn = document.getElementById('muteBtn');
    const volHighIcon = document.getElementById('volHighIcon');
    const volMuteIcon = document.getElementById('volMuteIcon');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const sunIcon = document.getElementById('sunIcon');
    const moonIcon = document.getElementById('moonIcon');
    const playlistSection = document.getElementById('playlistSection');
    const playlistBadge = document.getElementById('playlistBadge');
    const playlistItems = document.getElementById('playlistItems');
    const closePlaylistBtn = document.getElementById('closePlaylistBtn');

    if (closePlaylistBtn) {
      closePlaylistBtn.addEventListener('click', togglePlaylist);
    }

    const savedVol = parseFloat(localStorage.getItem('sp_player_volume'));
    audioEngine.volume = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 0.8;
    standbyEngine.volume = audioEngine.volume;
    lastVolume = audioEngine.volume || 0.8;
    if (volumeSlider) volumeSlider.value = audioEngine.volume;

    /* Theme Toggle */
    function initTheme() {
      const savedTheme = localStorage.getItem('sp_player_theme') || 'dark';
      applyTheme(savedTheme);
    }

    function applyTheme(theme) {
      if (theme === 'light') {
        document.body.classList.add('light');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
      } else {
        document.body.classList.remove('light');
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
      }
      localStorage.setItem('sp_player_theme', theme);
      updateSliderFill();
    }

    themeToggleBtn.addEventListener('click', () => {
      const isCurrentlyLight = document.body.classList.contains('light');
      applyTheme(isCurrentlyLight ? 'dark' : 'light');
    });

    initTheme();

    /* Folder Selection Wiring */
    async function triggerFolderSelect() {
      initAudioContext();
      
      // Modern Chromium / Edge: Native File System Access API avoids the "Upload X files?" confirmation prompt
      if ('showDirectoryPicker' in window) {
        try {
          const dirHandle = await window.showDirectoryPicker();
          const files = [];
          
          async function scanDirectory(handle) {
            for await (const entry of handle.values()) {
              if (entry.kind === 'file') {
                const file = await entry.getFile();
                files.push(file);
              } else if (entry.kind === 'directory') {
                await scanDirectory(entry);
              }
            }
          }

          await scanDirectory(dirHandle);
          processIncomingFiles(files);
          return;
        } catch (err) {
          // User dismissed picker dialog
          if (err.name === 'AbortError') return;
          console.warn("Directory picker error, falling back to input:", err);
        }
      }

      // Fallback for browsers without showDirectoryPicker
      folderPicker.click();
    }
    selectFolderBtn.addEventListener('click', triggerFolderSelect);
    coverOverlayBtn.addEventListener('click', triggerFolderSelect);

    /* Web Audio Keep-Alive for Background Tabs */
    function initAudioContext() {
      if (!audioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          audioCtx = new AudioCtxClass();
        }
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }

    folderPicker.addEventListener('change', (e) => {
      initAudioContext();
      processIncomingFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    // Drag and Drop folder/file handling (also suppresses upload confirmation popups)
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      initAudioContext();
      
      const items = e.dataTransfer.items;
      if (!items || !items.length) {
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          processIncomingFiles(Array.from(e.dataTransfer.files));
        }
        return;
      }

      const files = [];

      async function traverseEntry(entry) {
        if (entry.isFile) {
          return new Promise((resolve) => {
            entry.file((file) => {
              files.push(file);
              resolve();
            }, () => resolve());
          });
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          return new Promise((resolve) => {
            const readEntries = () => {
              dirReader.readEntries(async (entries) => {
                if (entries.length === 0) {
                  resolve();
                } else {
                  for (const subEntry of entries) {
                    await traverseEntry(subEntry);
                  }
                  readEntries();
                }
              }, () => resolve());
            };
            readEntries();
          });
        }
      }

      const traversePromises = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
        if (entry) {
          traversePromises.push(traverseEntry(entry));
        } else {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }

      await Promise.all(traversePromises);
      processIncomingFiles(files);
    });

    function processIncomingFiles(files) {
      if (!files.length) return;

      const audioFiles = files.filter(f => {
        const name = f.name.toLowerCase();
        return name.endsWith('.mp3') || name.endsWith('.m4a') || name.endsWith('.ogg') || name.endsWith('.wav') || name.endsWith('.flac');
      });

      if (audioFiles.length === 0) {
        trackTitle.textContent = "No audio files found in folder";
        trackArtist.textContent = "Please select another folder";
        return;
      }

      revokeAllObjectUrls();
      loadGeneration += 1;
      trackList = audioFiles;

      // Automatically construct randomized playlist order
      initShuffleOrder();
      
      folderBtnText.textContent = `${trackList.length} files`;
      playPauseBtn.disabled = false;
      fwdBtn.disabled = false;
      prevBtn.disabled = false;
      reshuffleBtn.disabled = false;
      togglePlaylistBtn.disabled = false;
      seekSlider.disabled = false;

      // Render randomized playlist queue
      renderPlaylistUI();

      // Begin playback at track 0 of the new randomized playlist
      currentIndex = 0;
      loadAndPlayTrack(shuffledIndices[currentIndex]);
    }

    function initShuffleOrder() {
      shuffledIndices = Array.from({ length: trackList.length }, (_, i) => i);
      // Fisher-Yates shuffle algorithm
      for (let i = shuffledIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]];
      }
    }

    function renderPlaylistUI() {
      playlistBadge.textContent = `${trackList.length} tracks`;
      playlistItems.innerHTML = '';

      shuffledIndices.forEach((fileIndex, queueIndex) => {
        const file = trackList[fileIndex];
        const cleanName = file.name.replace(/\.[^/.]+$/, "");
        
        const row = document.createElement('div');
        row.id = `playlist-row-${queueIndex}`;
        row.className = "flex items-center justify-between px-5 py-2.5 hover:bg-[var(--sp-highlight)]/60 cursor-pointer transition-colors text-sm group";
        
        row.innerHTML = `
          <div class="flex items-center gap-3 min-w-0 pr-2">
            <span class="queue-num text-xs font-mono text-[var(--sp-subtext)] w-6 text-right">${queueIndex + 1}</span>
            <div class="min-w-0">
              <p class="track-name text-sm font-medium text-[var(--sp-text)] truncate group-hover:text-[var(--sp-green)] transition-colors">${escapeHtml(cleanName)}</p>
              <p class="text-[11px] text-[var(--sp-subtext)] truncate">Local File</p>
            </div>
          </div>
          <span class="active-indicator hidden text-xs font-bold text-[var(--sp-green)] uppercase tracking-wider flex items-center gap-1.5 flex-shrink-0">
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--sp-green)] animate-ping"></span>
            Playing
          </span>
        `;

        row.addEventListener('click', () => {
          currentIndex = queueIndex;
          loadAndPlayTrack(shuffledIndices[currentIndex]);
        });

        playlistItems.appendChild(row);
      });
    }

    function updatePlaylistHighlight() {
      const rows = playlistItems.querySelectorAll('div[id^="playlist-row-"]');
      rows.forEach((row, idx) => {
        const isCurrent = idx === currentIndex;
        const nameEl = row.querySelector('.track-name');
        const numEl = row.querySelector('.queue-num');
        const indicator = row.querySelector('.active-indicator');

        if (isCurrent) {
          row.classList.add('bg-[var(--sp-highlight)]');
          nameEl.classList.add('text-[var(--sp-green)]');
          numEl.classList.add('text-[var(--sp-green)]');
          indicator.classList.remove('hidden');
          // Scroll active track into view inside the queue list
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          row.classList.remove('bg-[var(--sp-highlight)]');
          nameEl.classList.remove('text-[var(--sp-green)]');
          numEl.classList.remove('text-[var(--sp-green)]');
          indicator.classList.add('hidden');
        }
      });
    }

    function playNext() {
      if (trackList.length === 0 || isTransitioning) return;
      const wrapping = currentIndex + 1 >= shuffledIndices.length;
      if (wrapping) {
        setTransitioning(true);
        initShuffleOrder();
        currentIndex = 0;
        renderPlaylistUI();
        loadAndPlayTrack(shuffledIndices[currentIndex]);
        return;
      }

      const nextFi = shuffledIndices[currentIndex + 1];
      const standbyReady = (
        standbyFileIndex === nextFi &&
        standbyEngine &&
        standbyEngine.src &&
        standbyEngine.readyState >= 2
      );

      currentIndex++;
      if (standbyReady) {
        lastSkipAt = Date.now();
        swapEngines();
        const start = () => {
          audioEngine.currentTime = 0;
          const playPromise = audioEngine.play();
          if (playPromise && playPromise.then) {
            playPromise.then(() => {
              isPlaying = true;
              setTransitioning(false);
              updatePlayState(true);
              if (previousObjectUrl) {
                URL.revokeObjectURL(previousObjectUrl);
                previousObjectUrl = null;
              }
              preloadStandby();
            }).catch(() => {
              setTransitioning(false);
              loadAndPlayTrack(nextFi);
            });
          }
        };
        applyTrackMeta(trackList[nextFi]);
        counterDisplay.textContent = `${currentIndex + 1} / ${shuffledIndices.length}`;
        updatePlaylistHighlight();
        readId3Tags(trackList[nextFi], ++loadGeneration);
        start();
        return;
      }

      setTransitioning(true);
      loadAndPlayTrack(nextFi);
    }

    function playPrev() {
      if (trackList.length === 0 || isTransitioning) return;
      if (audioEngine.currentTime > 3) {
        audioEngine.currentTime = 0;
        return;
      }
      setTransitioning(true);
      currentIndex--;
      if (currentIndex < 0) {
        currentIndex = shuffledIndices.length - 1;
      }
      loadAndPlayTrack(shuffledIndices[currentIndex]);
    }

    function applyTrackMeta(file) {
      const cleanFileName = file.name.replace(/\.[^/.]+$/, "");
      trackTitle.textContent = cleanFileName;
      trackTitle.title = cleanFileName;
      trackArtist.textContent = "Unknown Artist";
      trackAlbum.textContent = "Local File";
      resetCoverArt();
      updateMediaSession(cleanFileName, "Unknown Artist", "Local File");
      return cleanFileName;
    }

    function loadAndPlayTrack(fileIndex) {
      const file = trackList[fileIndex];
      if (!file) {
        setTransitioning(false);
        return;
      }

      const thisLoad = ++loadGeneration;
      initAudioContext();

      // Defer revoking old blob URL until new track is ready
      if (previousObjectUrl) {
        URL.revokeObjectURL(previousObjectUrl);
        previousObjectUrl = null;
      }
      if (currentObjectUrl) {
        previousObjectUrl = currentObjectUrl;
      }

      currentObjectUrl = URL.createObjectURL(file);
      audioEngine.src = currentObjectUrl;
      audioEngine.load();

      const cleanFileName = applyTrackMeta(file);

      // Update counter & playlist highlight
      counterDisplay.textContent = `${currentIndex + 1} / ${shuffledIndices.length}`;
      updatePlaylistHighlight();

      // Read ID3 metadata (Title, Artist, Album, Cover Art)
      readId3Tags(file, thisLoad);

      // Play audio reliably
      const executePlay = () => {
        if (thisLoad !== loadGeneration) return;
        const playPromise = audioEngine.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            if (thisLoad !== loadGeneration) return;
            isPlaying = true;
            setTransitioning(false);
            updatePlayState(true);
            updateMediaSession(cleanFileName, "Unknown Artist", "Local File");
            if (previousObjectUrl) {
              URL.revokeObjectURL(previousObjectUrl);
              previousObjectUrl = null;
            }
            preloadStandby();
          }).catch((err) => {
            console.warn("Playback attempt deferred, retrying...", err);
            setTimeout(() => {
              if (thisLoad !== loadGeneration) return;
              audioEngine.play().then(() => {
                if (thisLoad !== loadGeneration) return;
                isPlaying = true;
                setTransitioning(false);
                updatePlayState(true);
              }).catch(() => {
                if (thisLoad !== loadGeneration) return;
                setTransitioning(false);
                updatePlayState(false);
              });
            }, 150);
          });
        }
      };

      if (audioEngine.readyState >= 2) {
        executePlay();
      } else {
        audioEngine.addEventListener('canplay', executePlay, { once: true });
      }
    }

    function updateMediaSession(title, artist, album, artwork) {
      if ('mediaSession' in navigator) {
        const meta = { title: title, artist: artist, album: album };
        if (artwork && artwork.length) meta.artwork = artwork;
        navigator.mediaSession.metadata = new MediaMetadata(meta);
        navigator.mediaSession.setActionHandler('play', () => audioEngine.play());
        navigator.mediaSession.setActionHandler('pause', () => audioEngine.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
        navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      }
    }

    function readId3Tags(file, expectedGeneration) {
      if (typeof window.jsmediatags === 'undefined') return;

      try {
        window.jsmediatags.read(file, {
          onSuccess: function(result) {
            if (expectedGeneration !== loadGeneration) return;
            const tags = result.tags;
            const finalTitle = tags.title && tags.title.trim() ? tags.title.trim() : file.name.replace(/\.[^/.]+$/, "");
            const finalArtist = tags.artist && tags.artist.trim() ? tags.artist.trim() : "Unknown Artist";
            const finalAlbum = tags.album && tags.album.trim() ? tags.album.trim() : "Local File";

            trackTitle.textContent = finalTitle;
            trackTitle.title = finalTitle;
            trackArtist.textContent = finalArtist;
            trackAlbum.textContent = finalAlbum;

            updateMediaSession(finalTitle, finalArtist, finalAlbum);

            // APIC frame cover artwork
            const pic = tags.picture;
            if (pic && pic.data && pic.data.length > 0) {
              try {
                let binary = '';
                const bytes = new Uint8Array(pic.data);
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                const base64String = window.btoa(binary);
                coverArt.src = `data:${pic.format};base64,${base64String}`;
                coverArt.classList.remove('hidden');
                coverPlaceholder.classList.add('hidden');
                updateMediaSession(finalTitle, finalArtist, finalAlbum, [{ src: coverArt.src, sizes: '512x512', type: pic.format || 'image/jpeg' }]);
              } catch (e) {
                resetCoverArt();
              }
            } else {
              resetCoverArt();
            }
          },
          onError: function() {
            if (expectedGeneration !== loadGeneration) return;
            resetCoverArt();
          }
        });
      } catch (err) {
        resetCoverArt();
      }
    }

    function resetCoverArt() {
      coverArt.src = "";
      coverArt.classList.add('hidden');
      coverPlaceholder.classList.remove('hidden');
    }

    function updatePlayState(isPlaying) {
      if (isPlaying) {
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
      } else {
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
      }
    }

    // Play / Pause toggle
    playPauseBtn.addEventListener('click', () => {
      if (!audioEngine.src) return;
      initAudioContext();
      if (audioEngine.paused) {
        audioEngine.play();
        isPlaying = true;
        updatePlayState(true);
      } else {
        audioEngine.pause();
        isPlaying = false;
        updatePlayState(false);
      }
    });

    // Control buttons
    fwdBtn.addEventListener('click', playNext);
    prevBtn.addEventListener('click', playPrev);

    // Toggle Playlist visibility
    function togglePlaylist() {
      if (trackList.length === 0) return;
      const isHidden = playlistSection.classList.toggle('hidden');
      if (!isHidden) {
        togglePlaylistBtn.classList.add('text-[var(--sp-green)]');
        togglePlaylistBtn.classList.remove('text-[var(--sp-subtext)]');
        // Scroll active track into view when opened
        const activeRow = document.getElementById(`playlist-row-${currentIndex}`);
        if (activeRow) activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        togglePlaylistBtn.classList.remove('text-[var(--sp-green)]');
        togglePlaylistBtn.classList.add('text-[var(--sp-subtext)]');
      }
    }
    togglePlaylistBtn.addEventListener('click', togglePlaylist);

    reshuffleBtn.addEventListener('click', () => {
      if (trackList.length === 0) return;
      initShuffleOrder();
      renderPlaylistUI();
      currentIndex = 0;
      loadAndPlayTrack(shuffledIndices[currentIndex]);
    });

    // Automatic continuous play on track end
    function bindPlaybackEvents(el) {
      el.addEventListener('ended', () => {
        if (el !== audioEngine) return;
        requestSkip('ended');
      });

      el.addEventListener('error', (e) => {
        if (el !== audioEngine) return;
        console.warn("Audio decoding error encountered. Skipping to next song...", e);
        setTransitioning(false);
        setTimeout(() => requestSkip('error'), 400);
      });

      el.addEventListener('loadedmetadata', () => {
        if (el !== audioEngine) return;
        totalDurationEl.textContent = formatTime(el.duration);
        seekSlider.max = el.duration || 100;
        seekSlider.value = 0;
        updateSliderFill();
      });

      el.addEventListener('timeupdate', () => {
        if (el !== audioEngine) return;
        if (!isUserSeeking) {
          seekSlider.value = el.currentTime;
          currentTimeEl.textContent = formatTime(el.currentTime);
          updateSliderFill();
          if (isPlaying && !isTransitioning && el.duration > 0) {
            const remain = el.duration - el.currentTime;
            if (remain <= 0.05) requestSkip('near-end');
          }
        }
      });
    }

    bindPlaybackEvents(audioEngine);
    bindPlaybackEvents(standbyEngine);

    // Time & Progress formatting
    function formatTime(seconds) {
      if (isNaN(seconds) || seconds < 0) return "0:00";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    }


    function updateSliderFill() {
      if (!seekSlider || !volumeSlider) return;
      const isLight = document.body.classList.contains('light');
      const green = isLight ? '#1db954' : '#1ed760';
      const bg = isLight ? '#e0e0e0' : '#4d4d4d';

      // Seek Slider Fill
      const seekMax = seekSlider.max || 100;
      const seekPct = (seekSlider.value / seekMax) * 100;
      seekSlider.style.background = `linear-gradient(to right, ${green} ${seekPct}%, ${bg} ${seekPct}%)`;

      // Volume Slider Fill
      const volPct = volumeSlider.value * 100;
      volumeSlider.style.background = `linear-gradient(to right, ${green} ${volPct}%, ${bg} ${volPct}%)`;
    }


    // Watchdog fallback: catches background tab thread freezes and unhandled stream ends
    setInterval(() => {
      if (trackList.length === 0 || isTransitioning || !isPlaying) return;
      if (audioEngine.ended || (audioEngine.duration > 0 && (audioEngine.duration - audioEngine.currentTime) <= 0.05)) {
        requestSkip('watchdog');
      }
    }, 1000);

    seekSlider.addEventListener('input', () => {
      isUserSeeking = true;
      currentTimeEl.textContent = formatTime(seekSlider.value);
      updateSliderFill();
    });

    seekSlider.addEventListener('change', () => {
      audioEngine.currentTime = seekSlider.value;
      isUserSeeking = false;
      updateSliderFill();
    });

    // Volume & Mute control
    volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      audioEngine.volume = val;
      standbyEngine.volume = val;
      if (val > 0) lastVolume = val;
      localStorage.setItem('sp_player_volume', String(val));
      updateVolumeIcons(val === 0);
      updateSliderFill();
    });

    function updateVolumeIcons(isMuted) {
      if (isMuted) {
        volHighIcon.classList.add('hidden');
        volMuteIcon.classList.remove('hidden');
      } else {
        volHighIcon.classList.remove('hidden');
        volMuteIcon.classList.add('hidden');
      }
    }

    muteBtn.addEventListener('click', () => {
      if (audioEngine.volume > 0) {
        lastVolume = audioEngine.volume;
        audioEngine.volume = 0;
        standbyEngine.volume = 0;
        volumeSlider.value = 0;
        updateVolumeIcons(true);
      } else {
        audioEngine.volume = lastVolume || 0.8;
        standbyEngine.volume = audioEngine.volume;
        volumeSlider.value = audioEngine.volume;
        updateVolumeIcons(false);
      }
      updateSliderFill();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

      if (e.code === 'Space') {
        e.preventDefault();
        playPauseBtn.click();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrev();
      } else if (e.code === 'KeyQ') {
        e.preventDefault();
        togglePlaylist();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        muteBtn.click();
      }
    });
