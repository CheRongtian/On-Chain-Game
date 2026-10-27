import { BaseError, ContractFunctionRevertedError } from 'viem';

const messages: Record<string, string> = {
  UnknownMatch: 'This room does not exist on the current local chain.',
  SelfJoin: 'Choose a different local account to join this room.',
  RoomFull: 'Both seats are taken. Refresh the room to see its players.',
  OpponentMissing: 'A second player must join before the host can start.',
  NotCreator: 'Only the account that created this room can start the game.',
  BattleNotStarted: 'The host has not started this game yet.',
  DeadlinePassed: 'The room or phase deadline has passed.',
  InvalidPhase: 'This room has changed. Refresh it before continuing.',
  UnknownMap: 'This map is unavailable.',
  NotPlayer: 'Only seated players can submit orders.',
  StaleRound: 'The round has advanced. Refresh before continuing.',
  AlreadyCommitted: 'Your orders are already committed. Refresh to restore the Reveal controls.',
  AlreadyRevealed: 'Your orders are already revealed. Refresh to see the next step.',
  CommitmentMismatch:
    'These orders or their Salt do not match your commitment. Import the original backup.',
  DeadlineNotPassed: 'The chain deadline has not passed yet. Refresh the phase before retrying.',
  InvalidActionEncoding: 'The order bundle has an invalid encoding.',
  InvalidAction: 'An order is invalid for its unit.',
  InvalidPath: 'A path is invalid for the round-start battlefield.',
  InvalidTarget: 'A target is invalid for the round-start battlefield.',
  InsufficientEnergy: 'The combined skill cost exceeds your round-start Energy.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return (
        messages[revert.data?.errorName ?? ''] ??
        'The contract rejected the transaction. Refresh the room and try again.'
      );
    }
    return 'Could not complete the request. Check that the local backend is running, then retry.';
  }
  return error instanceof Error
    ? error.message
    : 'The request could not be completed. Please retry.';
}
