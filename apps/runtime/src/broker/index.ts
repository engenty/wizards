/*
 * The broker: the one path every connector call takes (docs/plans/broker.md). Tools, share
 * targets, plugins and the run's browser import from here; `account.ts` stays the broker's own.
 */
export type { Account } from "./account.js";
export {
  type ActionKind,
  type BrokerAction,
  type BrokerCallInput,
  type BrokerConnection,
  type BrokerContext,
  type BrokerResult,
  brokerCall,
  brokerConnected,
  brokerSecret,
  type Decision,
  decide,
  grantBinds,
  inAudience,
  kindOf,
  type Refusal,
  signInRefused,
  type Where,
  type Who,
  type WhoKind,
  whereOf,
  whereOfRun,
  whoOf,
} from "./call.js";
export { type Caller, currentCaller, withCaller } from "./caller.js";
export {
  type Grant,
  grantNote,
  grantOf,
  hostInGrant,
  inGrant,
  type KnownConnector,
  runGrant,
} from "./grant.js";
export { brokerHost, type HostResult } from "./host.js";
export { keptStepIds } from "./kept.js";
export {
  CRITICAL_KINDS,
  type CriticalKind,
  criticalOf,
  criticalSince,
  LOG_PAGE,
  type LoggedRow,
  type LogQuery,
  lastUseOf,
  logOfSpace,
  logRuleChange,
  onCritical,
  RULE_CHANGE_ACTION,
  SIGN_IN_FAILED,
  summarizeInput,
} from "./log.js";
export { type OutsideReach, outsideReaches, reachesOutside } from "./registry.js";
export {
  brokerSend,
  GUEST_MAILS_PER_RUN,
  guestSendCheck,
  recipientsOf,
  runAddresses,
  type SendCheck,
  type SendRefusal,
  type SendResult,
} from "./send.js";
