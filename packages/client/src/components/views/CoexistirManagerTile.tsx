/**
 * CoexistirManagerTile — the front door's face, pinned in the meeting.
 *
 * The spec's non-goal list says "no 3D avatar: the agent's pinned meeting tile
 * IS its face". This is that tile: a small pinned card that greets the member
 * by CLAIM name, gives the morning briefing, walks the household todo list by
 * naming the real tasks, and offers a reflection question.
 *
 * It is text-first and reuses what slice-3 and slice-3b already built:
 *  - tasks come from the same server list the Tasks tab writes (managerApi)
 *  - speech goes through the existing `castalia:agent-reply` event, so the
 *    room's AgentVoiceToggle (Flux Mariana, EN/PT, on/off) stays in control
 *
 * Pinning is local UI state (localStorage), not room state: every member pins
 * their own copy, and collapsing it leaves a chip instead of hiding the agent.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStores } from '../../stores/MobxContext';
import { useAppSelector } from '../../hooks';
import { useOwlSpeakerLabels } from './useOwlSpeakerLabels';
import { voiceKeyForTile } from './voiceIdentityUtils';
import { pickMemberName } from '../../coexistir/tasksApi';
import {
  MANAGER_ACTIONS,
  ManagerIntent,
  ManagerOpenTask,
  ManagerTurn,
  fetchManagerTurn,
  speakManagerTurn,
} from '../../coexistir/managerApi';
import './CoexistirManagerTile.css';

const PINNED_KEY = 'castalia-coexistir-manager-pinned';

function readPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) !== '0';
  } catch {
    return true;
  }
}

function writePinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, pinned ? '1' : '0');
  } catch {
    /* private mode: pin state simply does not survive the reload */
  }
}

export const CoexistirManagerTile: React.FC = observer(() => {
  const { sharedLiveKitStore, networkStore } = useStores();
  const userName = useAppSelector((state) => state.user.displayName);
  const room = sharedLiveKitStore.room;
  const { getLabel } = useOwlSpeakerLabels(room);

  const localIdentity = sharedLiveKitStore.localParticipant?.identity ?? '';
  // The manager addresses the member by CLAIM name; the claim is resolved
  // server-side from this voice key (owl cluster), never from the tile name.
  const voiceKey = localIdentity
    ? voiceKeyForTile({
        owlSpeaker: getLabel(localIdentity)?.speaker,
        livekitIdentity: localIdentity,
      })
    : undefined;
  const displayName =
    pickMemberName({
      livekitName: sharedLiveKitStore.localParticipant?.name,
      userName,
      networkName: networkStore.displayName,
    }) ?? undefined;

  const [turn, setTurn] = useState<ManagerTurn | null>(null);
  const [tasks, setTasks] = useState<ManagerOpenTask[]>([]);
  const [intent, setIntent] = useState<ManagerIntent>('greeting');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<boolean>(() => readPinned());
  const greeted = useRef(false);

  const load = useCallback(
    async (next: ManagerIntent, opts: { speak?: boolean } = {}) => {
      setIntent(next);
      setLoading(true);
      setError(null);
      try {
        const result = await fetchManagerTurn({ intent: next, voiceKey, displayName });
        setTurn(result.turn);
        setTasks(result.tasks);
        if (opts.speak) speakManagerTurn(result.turn);
        return result.turn;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The manager is quiet right now');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [voiceKey, displayName],
  );

  // Front door: greet once the member is actually in the room. Speaking the
  // greeting is best-effort — the voice controller respects the room toggle.
  useEffect(() => {
    if (greeted.current) return;
    if (!localIdentity && !sharedLiveKitStore.isConnected) return;
    greeted.current = true;
    void load('greeting', { speak: true });
  }, [localIdentity, sharedLiveKitStore.isConnected, load]);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      writePinned(next);
      return next;
    });
  }, []);

  const handleAction = useCallback(
    (next: ManagerIntent) => {
      void load(next, { speak: true });
    },
    [load],
  );

  const openTasks = useMemo(() => tasks.filter((t) => t.status === 'open'), [tasks]);
  const managerName = turn?.managerName ?? 'Mara';

  if (!pinned) {
    return (
      <button
        type="button"
        className="coexistir-manager__chip"
        data-testid="manager-collapsed"
        onClick={togglePin}
        title={`${managerName} is at the front door — click to pin`}
      >
        <span className="coexistir-manager__chip-dot" aria-hidden="true">◉</span>
        {managerName}
        <span className="coexistir-manager__chip-pin" aria-hidden="true">📌</span>
      </button>
    );
  }

  return (
    <section
      className="coexistir-manager"
      data-testid="manager-tile"
      aria-label={`${managerName}, household manager`}
    >
      <header className="coexistir-manager__head">
        <span className="coexistir-manager__avatar" aria-hidden="true">M</span>
        <div className="coexistir-manager__id">
          <span className="coexistir-manager__name" data-testid="manager-name">
            {managerName}
          </span>
          <span className="coexistir-manager__role">household manager · pinned</span>
        </div>
        <span className="coexistir-manager__spacer" />
        <button
          type="button"
          className="coexistir-manager__icon"
          data-testid="manager-speak"
          onClick={() => turn && speakManagerTurn(turn)}
          disabled={!turn}
          title="Hear this again"
          aria-label="Hear this again"
        >
          🔊
        </button>
        <button
          type="button"
          className="coexistir-manager__icon"
          data-testid="manager-pin"
          onClick={togglePin}
          title="Unpin (keeps her as a chip)"
          aria-label="Unpin the manager tile"
        >
          📌
        </button>
      </header>

      <div className="coexistir-manager__body" data-testid="manager-text" role="status">
        {loading && !turn ? 'Mara is reading the house…' : null}
        {turn?.text ?? (error ? '' : '')}
      </div>

      {error && (
        <div className="coexistir-manager__error" role="alert" data-testid="manager-error">
          {error}
        </div>
      )}

      {openTasks.length > 0 && (
        <ul className="coexistir-manager__tasks" data-testid="manager-task-list">
          {openTasks.slice(0, 4).map((task) => (
            <li key={task.id} className="coexistir-manager__task" data-testid="manager-task">
              <span className="coexistir-manager__task-dot" aria-hidden="true">○</span>
              {task.title}
            </li>
          ))}
          {openTasks.length > 4 && (
            <li className="coexistir-manager__task coexistir-manager__task--more">
              +{openTasks.length - 4} more in Tasks
            </li>
          )}
        </ul>
      )}

      <div className="coexistir-manager__actions">
        {MANAGER_ACTIONS.map((action) => (
          <button
            key={action.intent}
            type="button"
            className={`coexistir-manager__action ${
              intent === action.intent ? 'coexistir-manager__action--active' : ''
            }`}
            data-testid={`manager-action-${action.intent}`}
            onClick={() => handleAction(action.intent)}
            disabled={loading}
            title={action.title}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
});

export default CoexistirManagerTile;
