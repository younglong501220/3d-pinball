import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { createPinballEngine, type PinballController } from './game/pinballEngine';

function formatArcadeScore(val: number): string {
  return String(val).padStart(6, '0');
}

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PinballController | null>(null);

  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [scorePop, setScorePop] = useState(false);
  const [ballsLeft, setBallsLeft] = useState(3);
  const [chargeRatio, setChargeRatio] = useState(0);
  const [bannerText, setBannerText] = useState<string | null>('HOLD [S / ▼] TO LAUNCH');
  const [gameOverState, setGameOverState] = useState<{
    active: boolean;
    finalScore: number;
    isNewRecord: boolean;
  }>({ active: false, finalScore: 0, isNewRecord: false });
  const [isMuted, setIsMuted] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  const scorePopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    const controller = createPinballEngine(mountEl, {
      onScoreChange: (nextScore, animate) => {
        setScore(nextScore);
        if (animate) {
          setScorePop(true);
          if (scorePopTimerRef.current !== null) {
            window.clearTimeout(scorePopTimerRef.current);
          }
          scorePopTimerRef.current = window.setTimeout(() => {
            setScorePop(false);
          }, 130);
        }
      },
      onHighScoreChange: (nextHi) => setHighScore(nextHi),
      onBallsChange: (nextBalls) => setBallsLeft(nextBalls),
      onChargeChange: (ratio) => setChargeRatio(ratio),
      onBannerChange: (text) => setBannerText(text),
      onGameOverChange: (active, finalScore, isNewRecord) => {
        setGameOverState({ active, finalScore, isNewRecord });
      },
      onContextLostChange: (lost) => setContextLost(lost)
    });

    engineRef.current = controller;

    return () => {
      if (scorePopTimerRef.current !== null) {
        window.clearTimeout(scorePopTimerRef.current);
      }
      controller.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setMuted(isMuted);
  }, [isMuted]);

  useEffect(() => {
    const handleToggleDock = (e: KeyboardEvent) => {
      if (e.code === 'KeyH') {
        setDockCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleToggleDock);
    return () => window.removeEventListener('keydown', handleToggleDock);
  }, []);

  const handleRestart = () => {
    engineRef.current?.restart();
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#060816] text-white select-none">
      {/* Isolated WebGL Viewport Container */}
      <div ref={canvasMountRef} className="fixed inset-0 w-full h-full" />

      {/* WebGL Context Lost Fallback */}
      {contextLost && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#060816]/95 p-6 text-center">
          <div className="max-w-sm rounded-xl border-2 border-[#ffbe0b] bg-[#140d28] p-6">
            <h2 className="font-arcade-display text-2xl font-bold tracking-wider text-[#ff4ecd]">
              DISPLAY INTERRUPTED
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              3D rendering context was temporarily suspended. Reload or click restart to resume.
            </p>
            <button
              type="button"
              onClick={handleRestart}
              className="mt-4 rounded-lg bg-[#ffbe0b] px-5 py-2.5 text-sm font-bold text-[#160900]"
            >
              Reset Machine
            </button>
          </div>
        </div>
      )}

      {/* Retro American Backglass Marquee HUD */}
      <header
        aria-label="Arcade Scoreboard"
        className="pointer-events-none fixed top-3 left-1/2 z-10 flex -translate-x-1/2 items-stretch overflow-hidden rounded-xl border-[3px] border-[#ffbe0b] backglass-scanlines shadow-[0_0_0_2px_#2b1200,0_0_26px_rgba(255,190,11,0.42),0_0_48px_rgba(255,0,128,0.25)] max-sm:origin-top max-sm:scale-[0.76]"
      >
        {/* Rivet Accents */}
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-gradient-to-br from-[#fff4cc] to-[#b8860b] shadow"
        />
        <span
          aria-hidden="true"
          className="absolute top-1/2 right-2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-gradient-to-br from-[#fff4cc] to-[#b8860b] shadow"
        />

        {/* 1UP Score */}
        <div className="flex flex-col items-center justify-center px-6 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-extrabold tracking-[2.2px] text-[#ffd166] [text-shadow:0_0_8px_rgba(255,183,3,0.8)]">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#ff2a6d] shadow-[0_0_8px_#ff2a6d]"
            />
            <span>1UP SCORE</span>
          </div>
          <div className="relative rounded-md border border-[#4d3510] bg-[#05030a] px-3 py-1 shadow-[inset_0_0_12px_rgba(0,0,0,0.95)]">
            <div
              aria-hidden="true"
              className="font-arcade-led text-[28px] leading-none font-extrabold tracking-[3px] text-[#ff6e00]/15"
            >
              888888
            </div>
            <div
              className={`font-arcade-led absolute inset-x-3 inset-y-1 leading-none font-extrabold tracking-[3px] transition-transform duration-100 text-[28px] ${
                scorePop
                  ? 'scale-105 text-[#fff3b0] [text-shadow:0_0_10px_#00f5d4,0_0_24px_#ff2ec4]'
                  : 'text-[#ffae00] [text-shadow:0_0_6px_#ff9100,0_0_16px_#ff5400]'
              }`}
            >
              {formatArcadeScore(score)}
            </div>
          </div>
        </div>

        {/* Center Marquee */}
        <div className="flex min-w-[172px] flex-col items-center justify-center border-x-2 border-[#ffbe0b]/45 bg-gradient-to-b from-[#ff0080]/15 to-[#00e5ff]/10 px-5 py-2">
          <div className="font-arcade-display whitespace-nowrap text-[15px] font-bold tracking-[2.5px] text-[#ff4ecd] [text-shadow:0_0_6px_#ff009d,0_0_14px_rgba(255,0,157,0.85),2px_2px_0_#1e0324]">
            ★ NEON STRIKE ★
          </div>
          <div className="mt-1 flex items-center gap-2 rounded border border-[#00f5d4]/45 bg-black/60 px-2.5 py-0.5">
            <span className="text-[9px] font-extrabold tracking-[1.5px] text-[#00f5d4]">
              HI-SCORE
            </span>
            <span className="font-arcade-led text-[13px] font-extrabold text-[#b8fff5] [text-shadow:0_0_8px_rgba(0,245,212,0.8)]">
              {formatArcadeScore(highScore)}
            </span>
          </div>
        </div>

        {/* Balls Remaining */}
        <div className="flex flex-col items-center justify-center px-6 py-2">
          <div className="mb-1 text-[10px] font-extrabold tracking-[2.2px] text-[#ffd166] [text-shadow:0_0_8px_rgba(255,183,3,0.8)]">
            BALLS IN PLAY
          </div>
          <div className="flex items-center gap-2.5 rounded-md border border-[#2c264a] bg-[#05030a] px-3 py-1.5 shadow-[inset_0_0_10px_rgba(0,0,0,0.95)]">
            <div className="flex items-center gap-2">
              {[0, 1, 2].map((idx) => {
                const active = idx < ballsLeft;
                return (
                  <span
                    key={idx}
                    className={`h-4 w-4 rounded-full transition-all duration-200 ${
                      active
                        ? 'bg-[radial-gradient(circle_at_32%_28%,#ffffff_0%,#9ce8ff_35%,#376996_80%,#131c31_100%)] shadow-[0_0_10px_rgba(0,229,255,0.9),0_0_3px_#ffffff]'
                        : 'scale-75 bg-slate-700/40 opacity-20'
                    }`}
                  />
                );
              })}
            </div>
            <span className="font-arcade-led min-w-[16px] text-center text-[19px] font-extrabold text-[#00f5d4] [text-shadow:0_0_10px_rgba(0,245,212,0.85)]">
              {ballsLeft}
            </span>
          </div>
        </div>
      </header>

      {/* Launch / Ball Ready Status Prompt */}
      <div
        className={`pointer-events-none fixed top-[98px] left-1/2 z-10 -translate-x-1/2 rounded-md border border-[#ffbe0b]/60 bg-[#180a20]/90 px-4 py-1 text-[12px] font-extrabold tracking-[2.2px] text-[#ffe066] shadow-[0_0_16px_rgba(255,145,0,0.3)] transition-opacity duration-200 max-sm:top-[82px] ${
          bannerText ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {bannerText ?? ''}
      </div>

      {/* Plunger Power Meter */}
      <div className="pointer-events-none fixed right-6 bottom-24 z-10 flex flex-col items-center gap-2 max-sm:right-3 max-sm:bottom-24">
        <div className="text-[10px] font-extrabold tracking-[2px] text-[#ffbe0b] [text-shadow:0_0_8px_rgba(255,190,11,0.85)]">
          PLUNGER
        </div>
        <div className="flex h-[152px] w-[18px] items-end rounded-full border-2 border-[#ffbe0b]/60 bg-[#0a0818]/90 p-[3px] shadow-[0_0_14px_rgba(255,107,0,0.3)]">
          <div
            style={{ height: `${Math.round(chargeRatio * 100)}%` }}
            className="w-full rounded-full bg-gradient-to-t from-[#00f5d4] via-[#ffbe0b] to-[#ff006e] shadow-[0_0_12px_rgba(255,0,110,0.9)]"
          />
        </div>
      </div>

      {/* Collapsible Bottom Arcade Control Dock */}
      <div className="fixed bottom-3 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center">
        <button
          type="button"
          onClick={() => setDockCollapsed((v) => !v)}
          title="Toggle controls bar (H)"
          className="mb-1.5 flex items-center gap-1 rounded-t-md border border-[#ffbe0b]/40 bg-[#0c0a1a]/90 px-3 py-0.5 text-[11px] font-semibold text-slate-300 transition-colors hover:border-[#ffbe0b] hover:text-[#ffd166]"
        >
          {dockCollapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              <span>Controls (H)</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              <span>Hide (H)</span>
            </>
          )}
        </button>

        {!dockCollapsed && (
          <footer className="flex flex-wrap items-center justify-center gap-2.5 rounded-xl border border-[#ffbe0b]/40 bg-[#0c0a1a]/92 px-3.5 py-2 shadow-[0_6px_28px_rgba(0,0,0,0.75)]">
            <button
              type="button"
              onPointerDown={() => engineRef.current?.setLeftFlipper(true)}
              onPointerUp={() => engineRef.current?.setLeftFlipper(false)}
              onPointerLeave={() => engineRef.current?.setLeftFlipper(false)}
              onPointerCancel={() => engineRef.current?.setLeftFlipper(false)}
              className="flex min-h-[40px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-[#ffbe0b]/55 bg-[#ffbe0b]/15 px-3.5 py-1.5 text-xs font-bold text-[#ffe066] transition-colors hover:bg-[#ffbe0b]/25 active:scale-95"
            >
              <span className="font-arcade-led rounded bg-[#ffbe0b]/20 px-1.5 py-0.5 text-[11px]">
                A / ◄
              </span>
              <span>左擋板</span>
            </button>

            <button
              type="button"
              onPointerDown={() => engineRef.current?.setPlungerDown(true)}
              onPointerUp={() => engineRef.current?.setPlungerDown(false)}
              onPointerLeave={() => engineRef.current?.setPlungerDown(false)}
              onPointerCancel={() => engineRef.current?.setPlungerDown(false)}
              className="flex min-h-[40px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-[#ff2ec4]/60 bg-[#ff2ec4]/15 px-3.5 py-1.5 text-xs font-bold text-[#ffb3e6] transition-colors hover:bg-[#ff2ec4]/25 active:scale-95"
            >
              <span className="font-arcade-led rounded bg-[#ff2ec4]/20 px-1.5 py-0.5 text-[11px]">
                S / ▼
              </span>
              <span>蓄力發射</span>
            </button>

            <button
              type="button"
              onPointerDown={() => engineRef.current?.setRightFlipper(true)}
              onPointerUp={() => engineRef.current?.setRightFlipper(false)}
              onPointerLeave={() => engineRef.current?.setRightFlipper(false)}
              onPointerCancel={() => engineRef.current?.setRightFlipper(false)}
              className="flex min-h-[40px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-[#ffbe0b]/55 bg-[#ffbe0b]/15 px-3.5 py-1.5 text-xs font-bold text-[#ffe066] transition-colors hover:bg-[#ffbe0b]/25 active:scale-95"
            >
              <span className="font-arcade-led rounded bg-[#ffbe0b]/20 px-1.5 py-0.5 text-[11px]">
                D / ►
              </span>
              <span>右擋板</span>
            </button>

            <div className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />

            <button
              type="button"
              onClick={() => setIsMuted((m) => !m)}
              aria-label={isMuted ? 'Unmute sound' : 'Mute sound'}
              title={isMuted ? 'Unmute sound' : 'Mute sound'}
              className="flex min-h-[40px] min-w-[40px] cursor-pointer items-center justify-center rounded-lg border border-white/15 bg-white/5 px-2.5 text-slate-200 transition-colors hover:border-[#00f5d4]/60 hover:text-[#00f5d4]"
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={handleRestart}
              aria-label="Restart game"
              title="Restart game"
              className="flex min-h-[40px] min-w-[40px] cursor-pointer items-center justify-center rounded-lg border border-white/15 bg-white/5 px-2.5 text-slate-200 transition-colors hover:border-[#ffbe0b]/60 hover:text-[#ffbe0b]"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </footer>
        )}
      </div>

      {/* Game Over Retro Arcade Modal */}
      {gameOverState.active && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="gameover-title"
          className="fixed inset-0 z-20 flex items-center justify-center bg-[#05040e]/85 p-4"
        >
          <div className="modal-scanlines w-full max-w-[430px] rounded-2xl border-[3px] border-[#ffbe0b] px-7 py-9 text-center shadow-[0_0_42px_rgba(255,0,128,0.45),0_0_22px_rgba(255,190,11,0.4),inset_0_0_26px_rgba(0,0,0,0.8)]">
            <h2
              id="gameover-title"
              className="font-arcade-display mb-2 text-[42px] leading-none font-bold tracking-[4px] text-[#ff2ec4] [text-shadow:0_0_10px_#ff009d,0_0_28px_rgba(255,0,157,0.85),3px_3px_0_#1f0429]"
            >
              GAME OVER
            </h2>
            <div className="mb-2.5 text-xs font-extrabold tracking-[3px] text-[#00f5d4]">
              FINAL SCORE
            </div>
            <div className="font-arcade-led mb-4 inline-block rounded-lg border-2 border-[#4d3510] bg-[#05030a] px-6 py-2 text-[42px] leading-none font-extrabold tracking-[3px] text-[#ffae00] [text-shadow:0_0_12px_#ff9100,0_0_28px_rgba(255,84,0,0.85)]">
              {formatArcadeScore(gameOverState.finalScore)}
            </div>

            {gameOverState.isNewRecord && (
              <div className="mb-4 text-[13px] font-extrabold tracking-[2px] text-[#00f5d4] [text-shadow:0_0_10px_#00f5d4]">
                ★ NEW HIGH SCORE RECORD! ★
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={handleRestart}
                className="cursor-pointer rounded-full border-2 border-[#fff3b0] bg-gradient-to-r from-[#ffbe0b] to-[#fb5607] px-8 py-3.5 text-sm font-extrabold tracking-[2px] text-[#160900] shadow-[0_0_24px_rgba(255,190,11,0.7)] transition-transform duration-150 hover:-translate-y-0.5 hover:scale-105 hover:shadow-[0_0_34px_rgba(255,190,11,0.95)] active:scale-95"
              >
                INSERT COIN · 重新開始
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
