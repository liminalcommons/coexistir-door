/**
 * CoexistirManagerTile.test.tsx — the pinned front door, as the owner sees it.
 *
 * Asserts the four things that make the tile real: it greets by claim name,
 * it lists the actual open tasks, the three actions each fetch a turn and
 * hand it to the voice layer, and unpinning leaves a chip (never disappears).
 */

const mockSharedLiveKitStore = {
  room: null as unknown,
  localParticipant: { identity: 'guest-1', name: 'Rita' } as { identity: string; name?: string } | null,
  isConnected: true,
};
const mockNetworkStore = { displayName: 'Rita' };

jest.mock('../../../stores/MobxContext', () => ({
  useStores: () => ({ sharedLiveKitStore: mockSharedLiveKitStore, networkStore: mockNetworkStore }),
}));
jest.mock('../../../hooks', () => ({
  useAppSelector: (selector: (state: any) => unknown) => selector({ user: { displayName: 'Rita' } }),
}));
jest.mock('../useOwlSpeakerLabels', () => ({
  useOwlSpeakerLabels: () => ({ getLabel: () => null, labelsVersion: 0, activeSpeakerIdentity: null }),
}));

const mockFetchTurn = jest.fn();
jest.mock('../../../coexistir/managerApi', () => {
  const actual = jest.requireActual('../../../coexistir/managerApi');
  return {
    ...actual,
    fetchManagerTurn: (...args: unknown[]) => mockFetchTurn(...args),
  };
});

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CoexistirManagerTile } from '../CoexistirManagerTile';
import { AGENT_REPLY_EVENT } from '../../../coexistir/agentVoice';

const greeting = {
  managerId: 'coexistir-manager',
  managerName: 'Mara',
  intent: 'greeting' as const,
  language: 'en',
  text: 'Good morning, Rita. Welcome back to Coexistir. One thing is still open for the house: Buy coffee.',
  namedTasks: ['Buy coffee'],
  openCount: 1,
  doneCount: 0,
};

const openTask = { id: '1', title: 'Buy coffee', status: 'open' as const };

beforeEach(() => {
  localStorage.clear();
  mockFetchTurn.mockReset();
  mockFetchTurn.mockResolvedValue({ turn: greeting, tasks: [openTask] });
});

describe('CoexistirManagerTile', () => {
  it('greets by claim name on mount and lists the real open tasks', async () => {
    const heard: string[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail.text);
    window.addEventListener(AGENT_REPLY_EVENT, listener);

    render(<CoexistirManagerTile />);

    expect(await screen.findByTestId('manager-name')).toHaveTextContent('Mara');
    await waitFor(() =>
      expect(screen.getByTestId('manager-text')).toHaveTextContent('Good morning, Rita'),
    );
    expect(screen.getByTestId('manager-task-list')).toHaveTextContent('Buy coffee');
    expect(mockFetchTurn).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'greeting', displayName: 'Rita' }),
    );
    // The greeting is spoken through the existing agent-reply event.
    await waitFor(() => expect(heard.join(' ')).toContain('Good morning, Rita'));

    window.removeEventListener(AGENT_REPLY_EVENT, listener);
  });

  it('fetches a briefing / todo review / reflection per button and speaks each', async () => {
    const heard: string[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail.text);
    window.addEventListener(AGENT_REPLY_EVENT, listener);

    render(<CoexistirManagerTile />);
    await screen.findByTestId('manager-tile');

    for (const intent of ['briefing', 'todos', 'reflection'] as const) {
      mockFetchTurn.mockResolvedValueOnce({
        turn: { ...greeting, intent, text: `${intent} from Mara` },
        tasks: [openTask],
      });
      fireEvent.click(screen.getByTestId(`manager-action-${intent}`));
      await waitFor(() =>
        expect(screen.getByTestId('manager-text')).toHaveTextContent(`${intent} from Mara`),
      );
      await waitFor(() => expect(heard.join(' ')).toContain(`${intent} from Mara`));
    }

    window.removeEventListener(AGENT_REPLY_EVENT, listener);
  });

  it('unpins to a chip and pins back, remembering the choice', async () => {
    render(<CoexistirManagerTile />);
    await screen.findByTestId('manager-tile');

    fireEvent.click(screen.getByTestId('manager-pin'));
    expect(screen.getByTestId('manager-collapsed')).toHaveTextContent('Mara');
    expect(screen.queryByTestId('manager-tile')).toBeNull();
    expect(localStorage.getItem('castalia-coexistir-manager-pinned')).toBe('0');

    fireEvent.click(screen.getByTestId('manager-collapsed'));
    expect(screen.getByTestId('manager-tile')).toBeInTheDocument();
    expect(localStorage.getItem('castalia-coexistir-manager-pinned')).toBe('1');
  });

  it('shows an error instead of a blank tile when the manager is unreachable', async () => {
    mockFetchTurn.mockRejectedValueOnce(new Error('Manager unavailable (502)'));
    render(<CoexistirManagerTile />);
    expect(await screen.findByTestId('manager-error')).toHaveTextContent('Manager unavailable');
  });
});
