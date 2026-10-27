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
