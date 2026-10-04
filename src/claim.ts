/**
 * Протокол claim'а — внутренний для пары «шлюз ↔ GHA-джоба».
 *
 * Зачем он нужен, если в issue #73 уже есть `POST /v1/launch` с ключом LLM в теле:
 * ключ нельзя положить в `inputs` диспатча. `workflow_dispatch` публичного репозитория
 * показывает inputs в метаданных прогона и в логах — то есть утечка ключа в мир.
 *
 * Поэтому в inputs едет только одноразовый `claimToken`:
 *   launch   → шлюз хранит LaunchRequest, диспатчит workflow с claim-токеном
 *   claim    → джоба обменивает токен на { spec, llmKey, reportToken }, токен гасится
 *   result   → джоба кладёт LaunchResult по report-токену, токен гасится
 *
 * Ни один токен не даёт доступа к содержимому задачи или ключу: ими только и
 * обмениваются, один раз, на конкретный `runId`.
 */

import type { LaunchRequest } from './contracts.js';

/** То, что джоба получает от шлюза после успешного claim'а. */
export interface ClaimPayload {
  runId: string;
  spec: LaunchRequest;
  /** Ключ LLM. Должен быть стёрт из памяти сразу после подстановки в env. */
  llmKey: string;
  /** Имя переменной для ключа в процессе агента. */
  llmKeyEnvName: string;
  /** Одноразовый токен для `POST /v1/runs/{runId}/result`. */
  reportToken: string;
  /** Куда положить результат. */
  reportUrl: string;
  /** Абсолютный путь к бинарю агента (или `opencode`, если он в PATH). */
  agentBinary: string;
}

export interface ClaimRequestBody {
  runId: string;
}

export interface ClaimErrorBody {
  error: string;
  issues?: string[];
}

export const CLAIM_PATH = '/v1/claim';

// ── Маршруты контракта (их зовёт наш API) ──────────────────────────────────────
/** `GET` — статус рана. */
export const STATUS_PATH = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/status`;
/** `GET` — финальный `LaunchResult` или 409, пока ран идёт. */
export const API_RESULT_PATH = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/result`;
/** `POST` — отмена рана. */
export const CANCEL_PATH = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/cancel`;

// ── Внутренний маршрут воркера (его зовёт GHA-джоба) ───────────────────────────
/**
 * `POST` — джоба кладёт `LaunchResult` по одноразовому report-токену.
 *
 * Отдельный путь от контрактного `/result`: тот `GET`-овый и публичный, а этот
 * `POST`-овый и по одноразовому токену. Один путь на два разных протокола — приглашение
 * к путанице, поэтому они разведены.
 */
export const REPORT_PATH = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/report`;

/** Имя переменной по умолчанию — совпадает с тем, чем наш API пользуется для llm-ladder. */
export const DEFAULT_LLM_KEY_ENV = 'LLM_LADDER_TOKEN';
