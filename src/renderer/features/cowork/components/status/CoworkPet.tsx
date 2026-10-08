import './CoworkPet.css';

import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { applyAppearanceConfig, normalizeAppearanceConfig, type PetCatSelection } from '@/app/appearance';
import { clampPetPosition, defaultPetPosition, PET_FLOATING_RESET_EVENT, type PetPosition,readPetPosition, savePetPosition } from '@/app/petFloating';
import { useWorkspaceNotificationDocument } from '@/app/shell/WorkspaceNotifications';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import asymmetricSpriteUrl from '../../../../../../resources/pets/black-white-cats/asymmetric-spritesheet.webp';
import extraSpriteUrl from '../../../../../../resources/pets/black-white-cats/extra-spritesheet.webp';
import interactionSpriteUrl from '../../../../../../resources/pets/black-white-cats/interaction-spritesheet.webp';
import reactionSpriteUrl from '../../../../../../resources/pets/black-white-cats/reaction-spritesheet.webp';
import spriteUrl from '../../../../../../resources/pets/black-white-cats/spritesheet.png';
import { petSpriteStyle } from './petSpriteStyle';

type PetFrame = readonly [number, number];

const IDLE: readonly PetFrame[] = [[1, 1100], [2, 120], [3, 800], [4, 160], [5, 120], [6, 900]];
const THINKING: readonly PetFrame[] = [[7, 450], [8, 250], [9, 350], [10, 600], [11, 350], [12, 450], [11, 250], [9, 250], [8, 250]];
const COMPLETE: readonly PetFrame[] = [[24, 500], [13, 160], [14, 120], [15, 140], [16, 300], [17, 120], [18, 160], [19, 200], [20, 300], [21, 120], [22, 350], [23, 140], [24, 800]];
const WAITING: readonly PetFrame[] = [[1, 550], [2, 180], [3, 450], [4, 180], [5, 450], [6, 550]];
const RESTING: readonly PetFrame[] = [[7, 650], [8, 500], [9, 650], [10, 900], [11, 650], [12, 500]];
const REACTION: readonly PetFrame[] = [[1, 250], [2, 450], [3, 650], [4, 600], [5, 500], [6, 600]];
const IDLE_ALTERNATE: readonly PetFrame[] = [[1, 1500], [2, 150], [3, 150], [4, 220], [5, 180], [6, 1400]];
const IDLE_BRIEF: readonly PetFrame[] = [[1, 900], [2, 120], [3, 700], [4, 150], [5, 130], [6, 1100]];
const THINKING_ALTERNATE: readonly PetFrame[] = [[7, 700], [8, 300], [9, 450], [10, 850], [11, 300], [12, 600], [11, 300], [10, 450], [9, 300], [8, 300]];
const THINKING_BRIEF: readonly PetFrame[] = [[7, 350], [8, 220], [9, 300], [10, 480], [11, 220], [12, 380], [11, 220], [9, 220], [8, 220]];
const WAITING_ALTERNATE: readonly PetFrame[] = [[1, 900], [2, 220], [3, 650], [4, 220], [5, 220], [6, 900]];
const WAITING_BRIEF: readonly PetFrame[] = [[1, 400], [2, 140], [3, 350], [4, 140], [5, 350], [6, 650]];
const RESTING_ALTERNATE: readonly PetFrame[] = [[7, 1100], [8, 550], [9, 850], [10, 1200], [11, 550], [12, 700]];
const RESTING_BRIEF: readonly PetFrame[] = [[7, 900], [8, 450], [9, 650], [10, 800], [11, 450], [12, 600]];

type PetMode = 'idle' | 'thinking' | 'waiting' | 'complete' | 'reaction' | 'resting';

type PetAnimation = { frames: readonly PetFrame[]; sheet: string; rows: number; repeat: boolean; still: number };

const loopVariants = (sequences: readonly (readonly PetFrame[])[], sheet: string, rows: number, still: number): PetAnimation[] => {
  const motions = [...sequences];
  for (const sequence of sequences) {
    const middle = Math.floor(sequence.length / 2);
    motions.push([[sequence[0][0], sequence[0][1] * 2], ...sequence.slice(1)]);
    motions.push([...sequence.slice(0, middle + 1), ...sequence.slice(1, middle).reverse(), ...sequence.slice(middle + 1)]);
    motions.push([...sequence.slice(0, middle), ...sequence.slice(middle, middle + 2), ...sequence.slice(middle)]);
  }
  return motions.map(frames => ({ frames, sheet, rows, repeat: true, still }));
};

// Six-frame paired scenes use different actions for each cat; split layers can
// also run their halves at independent cadences without changing character size.
const asymmetricLoops = (rows: readonly number[]): PetAnimation[] => rows.map(row => ({
  frames: [[row * 6 + 1, 1800], [row * 6 + 2, 260], [row * 6 + 3, 350],
    [row * 6 + 4, 600], [row * 6 + 5, 350], [row * 6 + 6, 1400]],
  sheet: asymmetricSpriteUrl, rows: 4, repeat: true, still: row * 6 + 1,
}));

const ANIMATIONS: Record<PetMode, readonly PetAnimation[]> = {
  idle: [...loopVariants([IDLE, IDLE_ALTERNATE, IDLE_BRIEF], spriteUrl, 4, 1), ...asymmetricLoops([0, 1, 2, 3])],
  thinking: [...loopVariants([THINKING, THINKING_ALTERNATE, THINKING_BRIEF], spriteUrl, 4, 7), ...asymmetricLoops([0, 3])],
  complete: [{ frames: COMPLETE, sheet: spriteUrl, rows: 4, repeat: false, still: 1 }],
  waiting: [...loopVariants([WAITING, WAITING_ALTERNATE, WAITING_BRIEF], extraSpriteUrl, 2, 3), ...asymmetricLoops([2])],
  resting: [...loopVariants([RESTING, RESTING_ALTERNATE, RESTING_BRIEF], extraSpriteUrl, 2, 10), ...asymmetricLoops([3])],
  reaction: [{ frames: REACTION, sheet: reactionSpriteUrl, rows: 1, repeat: false, still: 3 }],
};
const SOLO_COMPLETE: readonly PetAnimation[] = [
  { frames: [[1, 1100]], sheet: spriteUrl, rows: 4, repeat: false, still: 1 },
];
type InteractionKind = 'tap' | 'double';
type FeedbackMotion = 'wiggle' | 'nod' | 'hop' | 'stretch' | 'still';
const feedback = (frames: readonly PetFrame[], sheet: string, rows: number, motion: FeedbackMotion) => ({
  animations: [{ frames, sheet, rows, repeat: false, still: frames[0][0] }] as readonly PetAnimation[],
  motion,
});
const atlasFeedback = (row: number, playful: boolean, sheet = interactionSpriteUrl) => {
  const start = row * 6 + 1;
  const sequence: readonly PetFrame[] = [
    [start, 140], [start + 1, 150], [start + 2, 160],
    [start + 3, 220], [start + 4, 150], [start + 5, 240],
  ];
  const linger: readonly PetFrame[] = playful
    ? [...sequence.slice(0, 4), [start + 2, 120], [start + 3, 160], ...sequence.slice(4)]
    : [sequence[0], ...sequence.slice(1, 4), [start + 3, 180], ...sequence.slice(4)];
  return [
    feedback(sequence, sheet, 4, 'still'),
    feedback(linger, sheet, 4, 'still'),
  ];
};
const TAP_FEEDBACK = [
  feedback([[2, 140], [4, 180], [5, 120], [6, 320]], spriteUrl, 4, 'wiggle'),
  feedback([[7, 180], [8, 140], [9, 220], [8, 140], [7, 220]], spriteUrl, 4, 'nod'),
  feedback([[1, 160], [2, 130], [3, 180], [4, 130], [5, 180], [6, 220]], extraSpriteUrl, 2, 'hop'),
  feedback([[1, 220], [2, 120], [3, 160], [4, 120], [5, 120], [6, 220]], spriteUrl, 4, 'stretch'),
  ...[0, 1, 2, 3].flatMap(row => atlasFeedback(row, false)),
  ...[0, 1, 2, 3].flatMap(row => atlasFeedback(row, false, asymmetricSpriteUrl)),
];
const DOUBLE_FEEDBACK = [
  feedback([[13, 100], [14, 100], [15, 130], [16, 240], [17, 100], [18, 140], [24, 280]], spriteUrl, 4, 'hop'),
  feedback([[1, 130], [2, 100], [3, 160], [4, 100], [5, 160], [4, 100], [5, 160], [6, 200]], extraSpriteUrl, 2, 'wiggle'),
  feedback([[7, 150], [8, 120], [9, 160], [10, 220], [11, 120], [12, 150]], spriteUrl, 4, 'stretch'),
  feedback([[1, 140], [2, 100], [3, 200], [4, 100], [5, 100], [6, 240]], spriteUrl, 4, 'nod'),
  ...[0, 1, 2, 3].flatMap(row => atlasFeedback(row, true)),
  ...[0, 1, 2, 3].flatMap(row => atlasFeedback(row, true, asymmetricSpriteUrl)),
];
const SOLO_DOUBLE_FEEDBACK = [
  feedback([[1, 200], [2, 120], [3, 200], [4, 120], [5, 120], [6, 240]], spriteUrl, 4, 'hop'),
  ...DOUBLE_FEEDBACK.slice(1),
];
const SINGLE_CLICK_DELAY_MS = 260;

interface CoworkPetProps {
  running: boolean;
  waiting: boolean;
  latestRun?: SessionRunTiming;
  placement?: 'chat' | 'home';
}

const petSettings = () => {
  const data = document.documentElement.dataset;
  return {
    motionAllowed: data.coworkPet !== 'off' && data.coworkPetMotion !== 'off',
    variety: data.coworkPetVariety === 'classic' ? 1 : data.coworkPetVariety === 'varied' ? 4 : 16,
    speed: data.coworkPetSpeed === 'calm' ? 1.35 : data.coworkPetSpeed === 'lively' ? 0.75 : 1,
    restAfter: data.coworkPetRestAfter === 'never' ? null : data.coworkPetRestAfter === 'short' ? 30_000 :
      data.coworkPetRestAfter === 'long' ? 90_000 : 45_000,
    floating: data.coworkPetFloating === 'on',
    cats: (data.coworkPetCats === 'white' || data.coworkPetCats === 'black'
      ? data.coworkPetCats : 'both') as PetCatSelection,
  };
};

export function CoworkPet({ running, waiting, latestRun, placement = 'chat' }: CoworkPetProps) {
  const notificationDocument = useWorkspaceNotificationDocument();
  const [celebratingRunId, setCelebratingRunId] = useState<string | null>(null);
  const [reactingRunId, setReactingRunId] = useState<string | null>(null);
  const [resting, setResting] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [variantIndex, setVariantIndex] = useState(0);
  const [blackCursor, setBlackCursor] = useState({ frame: 0, variant: 0 });
  const [settings, setSettings] = useState(() => petSettings());
  const ownerDocument = settings.floating ? notificationDocument : document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const cellSize = 64;
  const [position, setPosition] = useState(() => readPetPosition(cellSize, ownerWindow));
  const [dragPosition, setDragPosition] = useState<PetPosition | null>(null);
  const [interaction, setInteraction] = useState<{ kind: InteractionKind; id: number; variant: number } | null>(null);
  const interactionSerialRef = useRef(0);
  const previousFeedbackRef = useRef<Record<string, number>>({});
  const clickTimerRef = useRef<number | null>(null);
  const draggedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: PetPosition; moved: boolean } | null>(null);
  const latestRunId = latestRun?.id;
  const latestRunState = latestRun?.state;
  const previousRunRef = useRef(latestRunId ? `${latestRunId}:${latestRunState}` : null);
  const wasRunningRef = useRef(running);

  useEffect(() => {
    const updateSettings = () => setSettings(petSettings());
    const updateVisibility = () => setDocumentVisible(!ownerDocument.hidden);
    updateVisibility();
    const observer = new MutationObserver(updateSettings);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-cowork-pet', 'data-cowork-pet-motion', 'data-cowork-pet-variety', 'data-cowork-pet-speed', 'data-cowork-pet-rest-after',
        'data-cowork-pet-floating', 'data-cowork-pet-cats'],
    });
    ownerDocument.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      ownerDocument.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [ownerDocument]);

  const { motionAllowed, variety, speed, restAfter, floating, cats } = settings;

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  useEffect(() => {
    if (!floating) setDragPosition(null);
  }, [floating]);

  useEffect(() => {
    const resize = () => {
      setPosition(current => clampPetPosition(current, cellSize, ownerWindow));
      setDragPosition(current => current ? clampPetPosition(current, cellSize, ownerWindow) : null);
    };
    const reset = () => {
      setPosition(defaultPetPosition(cellSize, ownerWindow));
      setDragPosition(null);
    };
    resize();
    ownerWindow.addEventListener('resize', resize);
    window.addEventListener(PET_FLOATING_RESET_EVENT, reset);
    return () => {
      ownerWindow.removeEventListener('resize', resize);
      window.removeEventListener(PET_FLOATING_RESET_EVENT, reset);
    };
  }, [cellSize, ownerWindow]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      draggedRef.current = true;
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      setInteraction(null);
      setDragPosition(clampPetPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, cellSize, ownerWindow));
    };
    const end = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      if (!drag.moved) return;
      const nextPosition = clampPetPosition({
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      }, cellSize, ownerWindow);
      setPosition(nextPosition);
      setDragPosition(nextPosition);
      savePetPosition(nextPosition);
      if (!floating) {
        const appearance = normalizeAppearanceConfig(configService.getConfig().appearance);
        const nextAppearance = { ...appearance, petFloatingEnabled: true };
        applyAppearanceConfig(nextAppearance);
        void configService.updateConfig({ appearance: nextAppearance });
      }
    };
    const cancel = (event: Event) => {
      if (!dragRef.current || ('pointerId' in event && event.pointerId !== dragRef.current.pointerId)) return;
      dragRef.current = null;
      setDragPosition(null);
    };
    ownerWindow.addEventListener('pointermove', move);
    ownerWindow.addEventListener('pointerup', end);
    ownerWindow.addEventListener('pointercancel', cancel);
    ownerWindow.addEventListener('blur', cancel);
    return () => {
      ownerWindow.removeEventListener('pointermove', move);
      ownerWindow.removeEventListener('pointerup', end);
      ownerWindow.removeEventListener('pointercancel', cancel);
      ownerWindow.removeEventListener('blur', cancel);
    };
  }, [cellSize, floating, ownerWindow]);

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
    if (running || waiting || celebratingRunId || reactingRunId || !motionAllowed || !documentVisible || restAfter === null) return;
    const timeout = window.setTimeout(() => setResting(true), restAfter);
    return () => window.clearTimeout(timeout);
  }, [running, waiting, celebratingRunId, reactingRunId, motionAllowed, documentVisible, restAfter]);

  const mode: PetMode = waiting ? 'waiting'
    : running ? 'thinking'
      : celebratingRunId ? 'complete'
        : reactingRunId ? 'reaction'
          : resting ? 'resting' : 'idle';
  useEffect(() => {
    setInteraction(null);
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }, [mode, motionAllowed, documentVisible, cats]);

  const selectedFeedback = interaction
    ? (interaction.kind === 'tap' ? TAP_FEEDBACK : cats === 'both' ? DOUBLE_FEEDBACK : SOLO_DOUBLE_FEEDBACK)[interaction.variant]
    : null;
  const animations = selectedFeedback
    ? selectedFeedback.animations
    : mode === 'complete' && cats !== 'both' ? SOLO_COMPLETE : ANIMATIONS[mode];
  const animation = animations[variantIndex] ?? animations[0];
  // Paired gestures cross the center of the atlas cell and must stay together.
  const independent = cats === 'both' && (interaction
    ? !(interaction.kind === 'double' && interaction.variant === 0)
    : mode !== 'complete');
  useEffect(() => {
    setFrameIndex(0);
    setVariantIndex(0);
    if (!motionAllowed || !documentVisible) return;
    setBlackCursor({ frame: 0, variant: 0 });
    const timers: number[] = [];
    let finished = 0;
    const finish = () => {
      finished += 1;
      if (finished < (independent ? 2 : 1)) return;
      if (interaction) setInteraction(null);
      else {
        setCelebratingRunId(null);
        setReactingRunId(null);
      }
    };
    const start = (black: boolean) => {
      let index = 0;
      let variant = 0;
      const cadence = speed * (black ? 0.88 : 1);
      const advance = () => {
        const current = animations[variant];
        index += 1;
        if (index >= current.frames.length) {
          if (!current.repeat) {
            finish();
            return;
          }
          index = 0;
          const count = Math.min(variety, animations.length);
          if (count > 1) variant = (variant + 1 + Math.floor(Math.random() * (count - 1))) % count;
        }
        if (black) setBlackCursor({ frame: index, variant });
        else {
          setVariantIndex(variant);
          setFrameIndex(index);
        }
        timeout = window.setTimeout(advance, animations[variant].frames[index][1] * cadence);
        timers[black ? 1 : 0] = timeout;
      };
      let timeout = window.setTimeout(advance, animations[0].frames[0][1] * cadence + (black ? 280 * speed : 0));
      timers[black ? 1 : 0] = timeout;
    };
    start(false);
    if (independent) start(true);
    return () => timers.forEach(window.clearTimeout);
  }, [animations, motionAllowed, documentVisible, variety, speed, interaction, independent]);

  const frame = !motionAllowed || !documentVisible
    ? animation.still
    : animation.frames[frameIndex]?.[0] ?? animation.frames[0][0];
  const blackAnimation = independent ? animations[blackCursor.variant] ?? animations[0] : animation;
  const blackFrame = !motionAllowed || !documentVisible ? blackAnimation.still
    : independent ? blackAnimation.frames[blackCursor.frame]?.[0] ?? blackAnimation.frames[0][0] : frame;
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

  const displayedPosition = dragPosition ?? position;
  const playInteraction = (kind: InteractionKind) => {
    const library = kind === 'tap' ? TAP_FEEDBACK : cats === 'both' ? DOUBLE_FEEDBACK : SOLO_DOUBLE_FEEDBACK;
    const historyKey = `${cats}:${kind}`;
    const previous = previousFeedbackRef.current[historyKey];
    const previousMotion = previous === undefined ? undefined : library[previous];
    const candidates = library.map((item, index) => ({ item, index })).filter(({ item }) =>
      !previousMotion || item.motion !== previousMotion.motion ||
      item.animations[0].sheet !== previousMotion.animations[0].sheet ||
      item.animations[0].frames[0][0] !== previousMotion.animations[0].frames[0][0],
    );
    const variant = candidates[Math.floor(Math.random() * candidates.length)].index;
    previousFeedbackRef.current[historyKey] = variant;
    setInteraction({ kind, variant, id: ++interactionSerialRef.current });
  };
  const pet = (
    <div
      className={`cowork-pet cowork-pet--${placement}${floating || dragPosition ? ' cowork-pet--floating' : ''}${!interaction && mode === 'complete' && cats !== 'both' ? ' cowork-pet--solo-complete' : ''}${interaction ? ` cowork-pet--${interaction.kind} cowork-pet--feedback-${selectedFeedback?.motion}` : ''}`}
      role="status"
      aria-label={label}
      style={floating || dragPosition ? { left: displayedPosition.x, top: displayedPosition.y } : undefined}
      onPointerDown={event => {
        if (event.button !== 0) return;
        draggedRef.current = false;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: floating || dragPosition ? displayedPosition : { x: rect.right - cellSize, y: rect.top - 8 },
          moved: false,
        };
      }}
      onClick={() => {
        if (draggedRef.current || !motionAllowed || !documentVisible) return;
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null;
          playInteraction('tap');
        }, SINGLE_CLICK_DELAY_MS);
      }}
      onDoubleClick={() => {
        if (draggedRef.current || !motionAllowed || !documentVisible) return;
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
        playInteraction('double');
      }}
    >
      <button
        type="button"
        className={`cowork-pet__sprite${cats === 'both' ? '' : ` cowork-pet__sprite--${cats}`}`}
        aria-label={i18nService.t('coworkPetInteract')}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (event.repeat || !motionAllowed || !documentVisible) return;
          draggedRef.current = false;
          if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
          playInteraction(event.shiftKey ? 'double' : 'tap');
        }}
      >
        <span aria-hidden="true" className={`cowork-pet__art${independent ? ' cowork-pet__art--white' : ''}`} style={petSpriteStyle(animation.sheet, animation.rows, frame, cellSize, independent ? 'white' : cats)} />
        {independent && <span aria-hidden="true" className="cowork-pet__art cowork-pet__art--black" style={petSpriteStyle(blackAnimation.sheet, blackAnimation.rows, blackFrame, cellSize, 'black')} />}
      </button>
    </div>
  );
  // Keep the original node mounted during the first drag so touch pointer capture survives.
  return floating ? createPortal(pet, ownerDocument.body) : pet;
}
