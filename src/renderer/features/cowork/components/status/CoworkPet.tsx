import './CoworkPet.css';

import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import extraSpriteUrl from '../../../../../../resources/pets/black-white-cats/extra-spritesheet.webp';
import reactionSpriteUrl from '../../../../../../resources/pets/black-white-cats/reaction-spritesheet.webp';
import spriteUrl from '../../../../../../resources/pets/black-white-cats/spritesheet.png';

type PetFrame = readonly [number, number];

const IDLE: readonly PetFrame[] = [[1, 1100], [2, 120], [3, 800], [4, 160], [5, 120], [6, 900]];
const THINKING: readonly PetFrame[] = [[7, 450], [8, 250], [9, 350], [10, 600], [11, 350], [12, 450], [11, 250], [9, 250], [8, 250]];
const COMPLETE: readonly PetFrame[] = [[24, 500], [13, 160], [14, 120], [15, 140], [16, 300], [17, 120], [18, 160], [19, 200], [20, 300], [21, 120], [22, 350], [23, 140], [24, 800]];
const WAITING: readonly PetFrame[] = [[1, 550], [2, 180], [3, 450], [4, 180], [5, 450], [6, 550]];
const RESTING: readonly PetFrame[] = [[7, 650], [8, 500], [9, 650], [10, 900], [11, 650], [12, 500]];
const REACTION: readonly PetFrame[] = [[1, 250], [2, 450], [3, 650], [4, 600], [5, 500], [6, 600]];

const IDLE_BEFORE_REST_MS = 45_000;

type PetMode = 'idle' | 'thinking' | 'waiting' | 'complete' | 'reaction' | 'resting';

const ANIMATIONS: Record<PetMode, { frames: readonly PetFrame[]; sheet: string; rows: number; repeat: boolean; still: number }> = {
  idle: { frames: IDLE, sheet: spriteUrl, rows: 4, repeat: true, still: 1 },
  thinking: { frames: THINKING, sheet: spriteUrl, rows: 4, repeat: true, still: 7 },
  complete: { frames: COMPLETE, sheet: spriteUrl, rows: 4, repeat: false, still: 1 },
  waiting: { frames: WAITING, sheet: extraSpriteUrl, rows: 2, repeat: true, still: 3 },
  resting: { frames: RESTING, sheet: extraSpriteUrl, rows: 2, repeat: true, still: 10 },
  reaction: { frames: REACTION, sheet: reactionSpriteUrl, rows: 1, repeat: false, still: 3 },
};

interface CoworkPetProps {
  running: boolean;
  waiting: boolean;
  latestRun?: SessionRunTiming;
  placement?: 'chat' | 'home';
}

const petMotionAllowed = () =>
  document.documentElement.dataset.coworkPet !== 'off' &&
  document.documentElement.dataset.coworkPetMotion !== 'off';

export function CoworkPet({ running, waiting, latestRun, placement = 'chat' }: CoworkPetProps) {
  const [celebratingRunId, setCelebratingRunId] = useState<string | null>(null);
  const [reactingRunId, setReactingRunId] = useState<string | null>(null);
  const [resting, setResting] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [motionAllowed, setMotionAllowed] = useState(petMotionAllowed);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const latestRunId = latestRun?.id;
  const latestRunState = latestRun?.state;
  const previousRunRef = useRef(latestRunId ? `${latestRunId}:${latestRunState}` : null);
  const wasRunningRef = useRef(running);

  useEffect(() => {
    const updateMotion = () => setMotionAllowed(petMotionAllowed());
    const updateVisibility = () => setDocumentVisible(!document.hidden);
    const observer = new MutationObserver(updateMotion);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-cowork-pet', 'data-cowork-pet-motion'],
    });
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  useEffect(() => {
    const previous = previousRunRef.current;
    const current = latestRunId ? `${latestRunId}:${latestRunState}` : null;
    previousRunRef.current = current;
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    const justSettled = latestRunId && !running && !waiting && motionAllowed && documentVisible &&
      (previous === `${latestRunId}:running` || wasRunning);
    if (justSettled && latestRunState === 'completed') {
      setReactingRunId(null);
      setCelebratingRunId(latestRunId);
    } else if (justSettled && (latestRunState === 'failed' || latestRunState === 'aborted')) {
      setCelebratingRunId(null);
      setReactingRunId(latestRunId);
    } else if (
      running || waiting || !motionAllowed || !documentVisible ||
      latestRunState === 'failed' || latestRunState === 'aborted'
    ) {
      setCelebratingRunId(null);
      if (!justSettled) setReactingRunId(null);
    }
  }, [latestRunId, latestRunState, running, waiting, motionAllowed, documentVisible]);

  useEffect(() => {
    setResting(false);
    if (running || waiting || celebratingRunId || reactingRunId || !motionAllowed || !documentVisible) return;
    const timeout = window.setTimeout(() => setResting(true), IDLE_BEFORE_REST_MS);
    return () => window.clearTimeout(timeout);
  }, [running, waiting, celebratingRunId, reactingRunId, motionAllowed, documentVisible]);

  const mode: PetMode = waiting ? 'waiting'
    : running ? 'thinking'
      : celebratingRunId ? 'complete'
        : reactingRunId ? 'reaction'
          : resting ? 'resting' : 'idle';
  const animation = ANIMATIONS[mode];
  useEffect(() => {
    setFrameIndex(0);
    if (!motionAllowed || !documentVisible) return;
    let index = 0;
    let timeout: number;
    const advance = () => {
      index += 1;
      if (index >= animation.frames.length) {
        if (!animation.repeat) {
          setCelebratingRunId(null);
          setReactingRunId(null);
          return;
        }
        index = 0;
      }
      setFrameIndex(index);
      timeout = window.setTimeout(advance, animation.frames[index][1]);
    };
    timeout = window.setTimeout(advance, animation.frames[0][1]);
    return () => window.clearTimeout(timeout);
  }, [mode, motionAllowed, documentVisible, animation]);

  const frame = !motionAllowed || !documentVisible
    ? animation.still
    : animation.frames[frameIndex]?.[0] ?? animation.frames[0][0];
  const cellSize = placement === 'home' ? 128 : 64;
  const label = waiting
    ? i18nService.t('coworkPetWaiting')
    : running
      ? i18nService.t('coworkPetWorking')
      : celebratingRunId
        ? i18nService.t('coworkPetCompleted')
        : reactingRunId
          ? i18nService.t(latestRunState === 'aborted' ? 'coworkPetStopped' : 'coworkPetFailed')
          : resting
            ? i18nService.t('coworkPetResting')
            : i18nService.t('coworkPetIdle');

  return (
    <div className={`cowork-pet cowork-pet--${placement}`} role="status" aria-label={label}>
      <span
        className="cowork-pet__sprite"
        aria-hidden="true"
        style={{
          backgroundImage: `url(${animation.sheet})`,
          backgroundSize: `${cellSize * 6}px ${cellSize * animation.rows}px`,
          backgroundPosition: `${-((frame - 1) % 6) * cellSize}px ${-Math.floor((frame - 1) / 6) * cellSize}px`,
        }}
      />
    </div>
  );
}
