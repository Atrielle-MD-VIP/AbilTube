'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Video, SponsorSegment, SponsorBlockSettings } from '@/types';
import { SponsorBlockService } from '@/lib/sponsorblock';
import { useApp } from '@/context/AppContext';
import { Play, RotateCcw, RotateCw, FastForward } from 'lucide-react';
import { backgroundAudioBridge } from '@/lib/background-audio';

interface YouTubePlayerProps {
  video: Video;
  settings: SponsorBlockSettings;
  onEnded?: () => void;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({ video, settings, onEnded }) => {
  const {
    isDarkMode,
    playerCurrentTime: globalCurrentTime,
    setPlayerCurrentTime: setGlobalCurrentTime,
    setPlayerDuration: setGlobalDuration,
    setIsPlayerPlaying: setGlobalIsPlaying,
  } = useApp();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<any>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const loadedVideoIdRef = useRef<string | null>(null);
  const lastSkippedUUIDRef = useRef<string | null>(null);

  // Capture the initial seek time once on component mount to keep iframe.src completely static
  const [initialStartSeconds] = useState<number>(() => Math.max(0, Math.floor(globalCurrentTime || 0)));
  const globalCurrentTimeRef = useRef<number>(globalCurrentTime);

  useEffect(() => {
    globalCurrentTimeRef.current = globalCurrentTime;
  }, [globalCurrentTime]);

  const [segments, setSegments] = useState<SponsorSegment[]>([]);
  const [, setPlayerCurrentTime] = useState<number>(globalCurrentTime || 0);
  const [, setPlayerDuration] = useState<number>(0);
  const [, setIsVideoPlaying] = useState<boolean>(false);
  const [isIframeLoaded, setIsIframeLoaded] = useState<boolean>(false);
  const [showPlayOverlay, setShowPlayOverlay] = useState<boolean>(false);

  // Controls overlay animation & visibility state
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const hideControlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [seekFeedback, setSeekFeedback] = useState<'rewind' | 'forward' | null>(null);
  const seekFeedbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Feature: Press & Hold for 2x Speed
  const [isHoldingFor2x, setIsHoldingFor2x] = useState<boolean>(false);
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const previousSpeedRef = useRef<number>(1);
  const isHoldingFor2xRef = useRef<boolean>(false);

  // Auto-hide center overlay controls after 3.5 seconds of inactivity
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3500);
  }, []);

  useEffect(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3500);
    return () => {
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    };
  }, [video.youtubeId]);

  // Static embed source that NEVER changes on tick updates, preventing iframe reload loops
  const embedSrc = React.useMemo(() => {
    const originParam = typeof window !== 'undefined' ? `&origin=${encodeURIComponent(window.location.origin)}` : '';
    return `https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&playsinline=1&enablejsapi=1&rel=0&modestbranding=1&iv_load_policy=3&start=${initialStartSeconds}${originParam}`;
  }, [video.youtubeId, initialStartSeconds]);

  // Keep references updated for the stable poller loop
  const segmentsRef = useRef<SponsorSegment[]>([]);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  const settingsRef = useRef<SponsorBlockSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const onEndedRef = useRef<(() => void) | undefined>(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  // Feature: Background Play & MediaSession integration (Lockscreen controls)
  const setupMediaSession = useCallback(() => {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      const highResArt = video.thumbnailUrl || `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: video.title,
        artist: video.channelTitle || 'AbilTube Creator',
        album: 'AbilTube',
        artwork: [
          { src: highResArt, sizes: '96x96', type: 'image/jpeg' },
          { src: highResArt, sizes: '128x128', type: 'image/jpeg' },
          { src: highResArt, sizes: '256x256', type: 'image/jpeg' },
          { src: highResArt, sizes: '512x512', type: 'image/jpeg' },
        ],
      });

      navigator.mediaSession.setActionHandler('play', () => {
        try {
          playerRef.current?.playVideo?.();
          backgroundAudioBridge.start();
          setIsVideoPlaying(true);
          setGlobalIsPlaying(true);
          navigator.mediaSession.playbackState = 'playing';
        } catch {}
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        try {
          playerRef.current?.pauseVideo?.();
          backgroundAudioBridge.stop();
          setIsVideoPlaying(false);
          setGlobalIsPlaying(false);
          navigator.mediaSession.playbackState = 'paused';
        } catch {}
      });

      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skip = details.seekOffset || 10;
        try {
          const cur = playerRef.current?.getCurrentTime?.() || 0;
          playerRef.current?.seekTo?.(Math.max(0, cur - skip), true);
        } catch {}
      });

      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skip = details.seekOffset || 10;
        try {
          const cur = playerRef.current?.getCurrentTime?.() || 0;
          playerRef.current?.seekTo?.(cur + skip, true);
        } catch {}
      });

      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
          try {
            playerRef.current?.seekTo?.(details.seekTime, true);
          } catch {}
        }
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (onEndedRef.current) onEndedRef.current();
      });

      navigator.mediaSession.setActionHandler('stop', () => {
        try {
          playerRef.current?.pauseVideo?.();
          backgroundAudioBridge.stop();
          setIsVideoPlaying(false);
          setGlobalIsPlaying(false);
        } catch {}
      });
    } catch (err) {
      console.warn('MediaSession notice:', err);
    }
  }, [video.title, video.channelTitle, video.thumbnailUrl, video.youtubeId, setGlobalIsPlaying]);

  // Keep background audio active when tab is hidden / device locked
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && playerRef.current) {
        try {
          const state = playerRef.current.getPlayerState?.();
          if (state === 1) {
            backgroundAudioBridge.start();
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
          }
        } catch {}
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Manual trigger play if browser blocked autoplay
  const handleManualPlay = () => {
    setShowPlayOverlay(false);
    setIsVideoPlaying(true);
    setGlobalIsPlaying(true);
    backgroundAudioBridge.start();

    if (playerRef.current) {
      try {
        playerRef.current.playVideo();
      } catch {}
    }
  };

  // Skip Rewind (-10s) and Forward (+10s) functions
  const handleSeekOffset = (offsetSeconds: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    showControlsTemporarily();

    if (!playerRef.current) return;

    try {
      const cur = playerRef.current.getCurrentTime?.() || 0;
      const dur = playerRef.current.getDuration?.() || 0;
      const target = Math.max(0, Math.min(dur || 999999, cur + offsetSeconds));
      playerRef.current.seekTo(target, true);

      // Trigger visual feedback animation
      setSeekFeedback(offsetSeconds < 0 ? 'rewind' : 'forward');
      if (seekFeedbackTimerRef.current) clearTimeout(seekFeedbackTimerRef.current);
      seekFeedbackTimerRef.current = setTimeout(() => {
        setSeekFeedback(null);
      }, 700);

      // Haptic vibration on mobile
      if (typeof window !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(25);
        } catch {}
      }
    } catch (err) {
      console.warn('Seek offset error:', err);
    }
  };

  // 1. Fetch SponsorBlock segments silently in background
  useEffect(() => {
    let isCancelled = false;

    async function loadSegments() {
      if (!video.youtubeId) return;
      try {
        const segs = await SponsorBlockService.getSegments(video.youtubeId);
        if (!isCancelled) {
          setSegments(segs);
        }
      } catch {
        // Quiet fail, playback is not interrupted
      }
    }

    loadSegments();

    return () => {
      isCancelled = true;
    };
  }, [video.youtubeId]);

  // 2. Playback Polling Handler
  const startPlaybackPolling = useCallback(() => {
    if (pollerRef.current) clearInterval(pollerRef.current);

    pollerRef.current = setInterval(() => {
      if (!playerRef.current) return;

      try {
        if (typeof playerRef.current.getCurrentTime !== 'function') return;

        const currentTime = playerRef.current.getCurrentTime();
        if (typeof currentTime !== 'number' || isNaN(currentTime)) return;

        // Local state update for smooth player overlay UI
        setPlayerCurrentTime(currentTime);

        let dur = 0;
        if (typeof playerRef.current.getDuration === 'function') {
          dur = playerRef.current.getDuration();
          if (typeof dur === 'number' && dur > 0) {
            setPlayerDuration(dur);
          }
        }

        // Sync lockscreen position state
        if ('mediaSession' in navigator && typeof navigator.mediaSession.setPositionState === 'function') {
          try {
            if (dur > 0 && currentTime <= dur) {
              const currentRate = isHoldingFor2xRef.current ? 2 : (playerRef.current.getPlaybackRate?.() || 1);
              navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: currentRate,
                position: Math.min(currentTime, dur),
              });
            }
          } catch {}
        }

        const currentSegments = segmentsRef.current;
        const currentSettings = settingsRef.current;

        // Check if user sought backwards before the last skipped segment
        if (lastSkippedUUIDRef.current && currentSegments.length > 0) {
          const lastSeg = currentSegments.find((s) => s.UUID === lastSkippedUUIDRef.current);
          if (lastSeg && (currentTime < lastSeg.segment[0] - 2 || currentTime > lastSeg.segment[1] + 2)) {
            lastSkippedUUIDRef.current = null;
          }
        }

        // SponsorBlock skip evaluation
        const targetSeg = SponsorBlockService.shouldSkip(
          currentTime,
          currentSegments,
          currentSettings,
          lastSkippedUUIDRef.current
        );

        if (targetSeg) {
          const targetEnd = targetSeg.segment[1];
          playerRef.current.seekTo(targetEnd, true);
          lastSkippedUUIDRef.current = targetSeg.UUID;
        }
      } catch {
        // Suppress polling error
      }
    }, 250);
  }, []);

  const stopPlaybackPolling = useCallback(() => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
  }, []);

  // 3. Attach YouTube IFrame API to the existing DOM iframe
  useEffect(() => {
    const targetVideoId = video.youtubeId;
    const resumeTime = Math.max(0, Math.floor(initialStartSeconds || 0));

    const bindYTPlayer = () => {
      if (!window.YT || !window.YT.Player) return;

      const iframeElem = document.getElementById('abiltube-yt-iframe-player');
      if (!iframeElem) return;

      // If already bound to this video
      if (playerRef.current && loadedVideoIdRef.current === targetVideoId) {
        return;
      }

      try {
        loadedVideoIdRef.current = targetVideoId;
        playerRef.current = new window.YT.Player('abiltube-yt-iframe-player', {
          events: {
            onReady: (event: any) => {
              setIsIframeLoaded(true);
              try {
                if (resumeTime > 0) {
                  event.target.seekTo(resumeTime, true);
                }
                event.target.playVideo();
                backgroundAudioBridge.start();
                setupMediaSession();
                if (typeof event.target.getDuration === 'function') {
                  const dur = event.target.getDuration();
                  if (dur > 0) {
                    setPlayerDuration(dur);
                    setGlobalDuration(dur);
                  }
                }
              } catch {}
              startPlaybackPolling();
            },
            onStateChange: (event: any) => {
              // 1 = PLAYING, 2 = PAUSED, 0 = ENDED, 3 = BUFFERING, -1 = UNSTARTED, 5 = CUED
              if (event.data === 1) {
                setIsVideoPlaying(true);
                setShowPlayOverlay(false);
                setGlobalIsPlaying(true);
                backgroundAudioBridge.start();
                setupMediaSession();
                if ('mediaSession' in navigator) {
                  navigator.mediaSession.playbackState = 'playing';
                }
                startPlaybackPolling();
              } else if (event.data === 2) {
                setIsVideoPlaying(false);
                setGlobalIsPlaying(false);
                backgroundAudioBridge.stop();
                if ('mediaSession' in navigator) {
                  navigator.mediaSession.playbackState = 'paused';
                }
                stopPlaybackPolling();
                try {
                  const cur = event.target.getCurrentTime?.();
                  if (typeof cur === 'number' && cur > 0) {
                    setGlobalCurrentTime(cur);
                  }
                } catch {}
              } else if (event.data === 0) {
                setIsVideoPlaying(false);
                setGlobalIsPlaying(false);
                backgroundAudioBridge.stop();
                if ('mediaSession' in navigator) {
                  navigator.mediaSession.playbackState = 'none';
                }
                stopPlaybackPolling();
                if (onEndedRef.current) onEndedRef.current();
              } else if (event.data === -1 || event.data === 5) {
                try {
                  event.target.playVideo();
                } catch {}
              }
            },
            onError: () => {
              setIsIframeLoaded(true);
            },
          },
        });
      } catch (err) {
        console.warn('YouTube Player binding notice:', err);
      }
    };

    // If script not loaded yet, inject it
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);

      window.onYouTubeIframeAPIReady = () => {
        bindYTPlayer();
      };
    } else if (window.YT && window.YT.Player) {
      bindYTPlayer();
    }
  }, [video.youtubeId, initialStartSeconds, startPlaybackPolling, stopPlaybackPolling, setGlobalIsPlaying, setGlobalDuration, setGlobalCurrentTime, setupMediaSession]);

  // Clean up poller and preserve playback position to global context on unmount
  useEffect(() => {
    return () => {
      if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
        try {
          const finalTime = playerRef.current.getCurrentTime();
          if (typeof finalTime === 'number' && !isNaN(finalTime) && finalTime > 0) {
            setGlobalCurrentTime(finalTime);
          }
        } catch {}
      }
      if (pollerRef.current) clearInterval(pollerRef.current);
    };
  }, [setGlobalCurrentTime]);

  // Press & Hold for 2x Fast Forward Handlers
  const handleHoldStart = (clientX: number, clientY: number) => {
    touchStartPosRef.current = { x: clientX, y: clientY };

    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);

    holdTimerRef.current = setTimeout(() => {
      if (!playerRef.current) return;

      try {
        const currentRate = playerRef.current.getPlaybackRate?.() || 1;
        previousSpeedRef.current = currentRate;
        playerRef.current.setPlaybackRate(2);
        isHoldingFor2xRef.current = true;
        setIsHoldingFor2x(true);

        if (typeof window !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate(35);
          } catch {}
        }
      } catch (err) {
        console.warn('Set 2x rate error:', err);
      }
    }, 240);
  };

  const handleHoldMove = (clientX: number, clientY: number) => {
    if (!touchStartPosRef.current) return;
    const dx = Math.abs(clientX - touchStartPosRef.current.x);
    const dy = Math.abs(clientY - touchStartPosRef.current.y);

    if (dx > 15 || dy > 15) {
      if (holdTimerRef.current && !isHoldingFor2xRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    }
  };

  const handleHoldEnd = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    touchStartPosRef.current = null;

    if (isHoldingFor2xRef.current) {
      isHoldingFor2xRef.current = false;
      setIsHoldingFor2x(false);

      if (playerRef.current) {
        try {
          const originalRate = previousSpeedRef.current || 1;
          playerRef.current.setPlaybackRate(originalRate);
        } catch {}
      }
    }
  };

  return (
    <div
      id="abiltube-player-wrapper"
      className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black shadow-2xl border border-gray-200 dark:border-[#222] select-none group touch-none"
      onMouseMove={() => showControlsTemporarily()}
      onMouseDown={(e) => handleHoldStart(e.clientX, e.clientY)}
      onMouseUp={handleHoldEnd}
      onMouseLeave={handleHoldEnd}
      onTouchStart={(e) => {
        showControlsTemporarily();
        if (e.touches.length === 1) {
          handleHoldStart(e.touches[0].clientX, e.touches[0].clientY);
        }
      }}
      onTouchMove={(e) => {
        if (e.touches.length === 1) {
          handleHoldMove(e.touches[0].clientX, e.touches[0].clientY);
        }
      }}
      onTouchEnd={handleHoldEnd}
      onTouchCancel={handleHoldEnd}
    >
      {/* Fast Direct Native IFrame - Instant Load without black screen */}
      <iframe
        ref={iframeRef}
        id="abiltube-yt-iframe-player"
        src={embedSrc}
        title={video.title}
        className="w-full h-full border-0 absolute inset-0 z-0"
        style={{ colorScheme: isDarkMode ? 'dark' : 'light' }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        onLoad={() => setIsIframeLoaded(true)}
      />

      {/* Center Floating Quick (10) Mundur & (10) Maju Controls */}
      {isIframeLoaded && !showPlayOverlay && (
        <div
          id="abiltube-center-quick-controls"
          className={`absolute inset-0 z-20 flex items-center justify-between px-6 sm:px-14 md:px-24 pointer-events-none transition-all duration-300 ${
            controlsVisible || isHoldingFor2x || seekFeedback ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'
          }`}
        >
          {/* Tombol Mundur (10s) */}
          <button
            type="button"
            id="quick-rewind-10s-btn"
            onClick={(e) => handleSeekOffset(-10, e)}
            title="Mundur 10 Detik"
            className="pointer-events-auto flex flex-col items-center justify-center w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/60 hover:bg-red-600 active:scale-90 text-white backdrop-blur-md border border-white/20 shadow-xl transition-all hover:scale-110 cursor-pointer focus:outline-none"
          >
            <div className="relative flex items-center justify-center">
              <RotateCcw className="w-6 h-6 sm:w-7 sm:h-7 stroke-[2.2]" />
              <span className="absolute text-[9px] sm:text-[10px] font-black tracking-tighter text-white">10</span>
            </div>
            <span className="text-[9px] font-bold text-gray-200 mt-0.5 hidden sm:inline">-10s</span>
          </button>

          {/* Quick Seek Feedback Flash Animation di Tengah Layar */}
          {seekFeedback && (
            <div className="pointer-events-none px-4 py-2 rounded-full bg-black/80 backdrop-blur-md border border-white/30 text-white text-xs sm:text-sm font-bold shadow-2xl animate-in zoom-in-75 fade-in duration-150 flex items-center gap-2">
              {seekFeedback === 'rewind' ? (
                <>
                  <RotateCcw className="w-4 h-4 text-red-500 animate-spin" />
                  <span>Mundur 10 Detik</span>
                </>
              ) : (
                <>
                  <RotateCw className="w-4 h-4 text-red-500 animate-spin" />
                  <span>Maju 10 Detik</span>
                </>
              )}
            </div>
          )}

          {/* Tombol Maju (10s) */}
          <button
            type="button"
            id="quick-forward-10s-btn"
            onClick={(e) => handleSeekOffset(10, e)}
            title="Percepat / Maju 10 Detik"
            className="pointer-events-auto flex flex-col items-center justify-center w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/60 hover:bg-red-600 active:scale-90 text-white backdrop-blur-md border border-white/20 shadow-xl transition-all hover:scale-110 cursor-pointer focus:outline-none"
          >
            <div className="relative flex items-center justify-center">
              <RotateCw className="w-6 h-6 sm:w-7 sm:h-7 stroke-[2.2]" />
              <span className="absolute text-[9px] sm:text-[10px] font-black tracking-tighter text-white">10</span>
            </div>
            <span className="text-[9px] font-bold text-gray-200 mt-0.5 hidden sm:inline">+10s</span>
          </button>
        </div>
      )}

      {/* 2X Speed Active Animated Badge (Press & Hold Overlay) */}
      {isHoldingFor2x && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 py-2 rounded-full bg-black/90 backdrop-blur-md border border-red-500/60 text-white shadow-2xl animate-in fade-in zoom-in-95 pointer-events-none select-none ring-2 ring-red-500/20">
          <div className="flex items-center gap-1.5 text-red-500 font-black tracking-wider text-sm">
            <FastForward className="w-5 h-5 animate-pulse fill-red-500" />
            <span>2X SPEED</span>
          </div>
          <div className="w-px h-3.5 bg-white/20" />
          <span className="text-xs font-medium text-gray-200">Lepas layar untuk normal</span>
        </div>
      )}

      {/* Poster Placeholder (shown briefly before first frame renders to eliminate pure black screen) */}
      {!isIframeLoaded && (
        <div className="absolute inset-0 z-10 bg-black flex items-center justify-center pointer-events-none transition-opacity duration-300">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={video.thumbnailUrl || `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`}
            alt={video.title}
            className="w-full h-full object-cover blur-xs opacity-60 scale-105"
          />
          <div className="absolute flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-full border-3 border-red-500 border-t-transparent animate-spin" />
            <span className="text-xs text-white/90 font-medium drop-shadow-md">Memuat video...</span>
          </div>
        </div>
      )}

      {/* Play Overlay if autoplay was prevented by browser */}
      {showPlayOverlay && (
        <div
          onClick={handleManualPlay}
          className="absolute inset-0 z-20 bg-black/60 backdrop-blur-xs flex flex-col items-center justify-center cursor-pointer group/play"
        >
          <div className="w-16 h-16 rounded-full bg-red-600 group-hover/play:scale-110 group-hover/play:bg-red-700 text-white flex items-center justify-center shadow-2xl transition-transform">
            <Play className="w-7 h-7 fill-white translate-x-0.5" />
          </div>
          <span className="text-white text-xs font-semibold mt-3 bg-black/70 px-3 py-1 rounded-full">
            Ketuk untuk melanjutkan video
          </span>
        </div>
      )}
    </div>
  );
};
