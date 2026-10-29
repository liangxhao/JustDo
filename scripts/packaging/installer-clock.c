#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

/* This module never enters the NSIS interpreter. All context access is protected
 * because Stop may run on the installation worker while timers run on the GUI. */
#define CLOCK_PREFIX_CAPACITY 64
#define CLOCK_TEXT_CAPACITY (CLOCK_PREFIX_CAPACITY + 16)
#define CLOCK_CAPTION_CAPACITY 64
#define CLOCK_INTERVAL_MS 250

typedef struct ClockContext {
  DWORD started;
  DWORD stoppedAt;
  BOOL stopped;
  UINT_PTR timer;
  WCHAR prefix[CLOCK_PREFIX_CAPACITY];
} ClockContext;

typedef struct PendingActions {
  HWND openButton;
  HWND closeButton;
  UINT_PTR timer;
  WCHAR openCaption[CLOCK_CAPTION_CAPACITY];
  WCHAR closeCaption[CLOCK_CAPTION_CAPACITY];
} PendingActions;

static const WCHAR clockProperty[] = L"installer-clock.context";
static const WCHAR actionsTimerProperty[] = L"installer-clock.actions-timer";
static SRWLOCK clockLock = SRWLOCK_INIT;
static UINT_PTR nextTimer = 0x45000000;
static PendingActions pendingActions;

static BOOL PinModule(void) {
  HMODULE module;
  /* KillTimer does not remove queued TIMERPROC addresses. Pin this tiny module
   * for the installer process lifetime so even late dispatch remains safe. */
  return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
    (LPCWSTR)(UINT_PTR)&PinModule, &module);
}

static void FormatElapsed(const ClockContext *context, DWORD now, WCHAR *text) {
  DWORD seconds = (now - context->started) / 1000;
  DWORD minutes = seconds / 60;
  DWORD digitCount = 0;
  WCHAR digits[10];
  DWORD position = 0;

  while (context->prefix[position] != L'\0') {
    text[position] = context->prefix[position];
    position++;
  }
  do {
    digits[digitCount++] = (WCHAR)(L'0' + minutes % 10);
    minutes /= 10;
  } while (minutes != 0);
  if (digitCount < 2) text[position++] = L'0';
  while (digitCount != 0) text[position++] = digits[--digitCount];
  text[position++] = L':';
  text[position++] = (WCHAR)(L'0' + (seconds % 60) / 10);
  text[position++] = (WCHAR)(L'0' + seconds % 10);
  text[position] = L'\0';
}

static VOID CALLBACK ClockTimer(HWND label, UINT message, UINT_PTR timer, DWORD tick) {
  ClockContext *context;
  WCHAR text[CLOCK_TEXT_CAPACITY];
  BOOL render = FALSE;
  (void)message;
  (void)tick;

  AcquireSRWLockExclusive(&clockLock);
  context = (ClockContext *)GetPropW(label, clockProperty);
  if (context != NULL && context->timer == timer && !context->stopped) {
    FormatElapsed(context, GetTickCount(), text);
    render = TRUE;
  }
  ReleaseSRWLockExclusive(&clockLock);
  if (!render) return;
  SetWindowTextW(label, text);

  /* A worker Stop can send its final text while SetWindowText dispatches a sent
   * message. Re-read by HWND/id and repaint that frozen value after an old tick.
   * No context pointer survives a call which can dispatch window messages. */
  render = FALSE;
  AcquireSRWLockExclusive(&clockLock);
  context = (ClockContext *)GetPropW(label, clockProperty);
  if (context != NULL && context->timer == timer && context->stopped) {
    FormatElapsed(context, context->stoppedAt, text);
    render = TRUE;
  }
  ReleaseSRWLockExclusive(&clockLock);
  if (render) SetWindowTextW(label, text);
}

BOOL WINAPI Start(HWND label, DWORD started, LPCWSTR prefix) {
  ClockContext *context;
  DWORD process;
  DWORD length = 0;
  WCHAR text[CLOCK_TEXT_CAPACITY];
  UINT_PTR timer;

  if (prefix == NULL || GetWindowThreadProcessId(label, &process) != GetCurrentThreadId()
      || process != GetCurrentProcessId()) return FALSE;
  while (prefix[length] != L'\0') {
    if (length >= CLOCK_PREFIX_CAPACITY - 1) return FALSE;
    length++;
  }
  context = (ClockContext *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(ClockContext));
  if (context == NULL) return FALSE;
  context->started = started;
  for (length = 0; prefix[length] != L'\0'; length++) context->prefix[length] = prefix[length];

  if (!PinModule()) {
    HeapFree(GetProcessHeap(), 0, context);
    return FALSE;
  }
  AcquireSRWLockExclusive(&clockLock);
  if (GetPropW(label, clockProperty) != NULL) {
    ReleaseSRWLockExclusive(&clockLock);
    HeapFree(GetProcessHeap(), 0, context);
    return FALSE;
  }
  nextTimer++;
  if (nextTimer == 0) nextTimer++;
  timer = nextTimer;
  if (!SetPropW(label, clockProperty, context)) {
    ReleaseSRWLockExclusive(&clockLock);
    HeapFree(GetProcessHeap(), 0, context);
    return FALSE;
  }
  context->timer = SetTimer(label, timer, CLOCK_INTERVAL_MS, ClockTimer);
  if (context->timer == 0) {
    RemovePropW(label, clockProperty);
    ReleaseSRWLockExclusive(&clockLock);
    HeapFree(GetProcessHeap(), 0, context);
    return FALSE;
  }
  FormatElapsed(context, GetTickCount(), text);
  ReleaseSRWLockExclusive(&clockLock);
  SetWindowTextW(label, text);
  return TRUE;
}

BOOL WINAPI Stop(HWND label) {
  ClockContext *context;
  WCHAR text[CLOCK_TEXT_CAPACITY];
  UINT_PTR timer;

  AcquireSRWLockExclusive(&clockLock);
  context = (ClockContext *)GetPropW(label, clockProperty);
  if (context == NULL) {
    ReleaseSRWLockExclusive(&clockLock);
    return TRUE;
  }
  if (!context->stopped) {
    context->stopped = TRUE;
    context->stoppedAt = GetTickCount();
  }
  timer = context->timer;
  FormatElapsed(context, context->stoppedAt, text);
  ReleaseSRWLockExclusive(&clockLock);
  KillTimer(label, timer);
  return SetWindowTextW(label, text);
}

BOOL WINAPI Destroy(HWND label) {
  ClockContext *context;
  DWORD process;

  if (GetWindowThreadProcessId(label, &process) != GetCurrentThreadId()
      || process != GetCurrentProcessId()) return FALSE;
  AcquireSRWLockExclusive(&clockLock);
  context = (ClockContext *)RemovePropW(label, clockProperty);
  if (context != NULL) KillTimer(label, context->timer);
  ReleaseSRWLockExclusive(&clockLock);
  if (context != NULL) HeapFree(GetProcessHeap(), 0, context);
  return TRUE;
}

static BOOL OwnsActions(HWND openButton, HWND closeButton) {
  DWORD process;
  DWORD thread = GetCurrentThreadId();
  DWORD currentProcess = GetCurrentProcessId();
  if (openButton == closeButton || GetWindowThreadProcessId(openButton, &process) != thread
      || process != currentProcess || GetWindowThreadProcessId(closeButton, &process) != thread
      || process != currentProcess) return FALSE;
  return GetParent(openButton) == GetParent(closeButton)
    && GetAncestor(openButton, GA_ROOT) == GetAncestor(closeButton, GA_ROOT);
}

static BOOL CaptionFits(LPCWSTR caption) {
  DWORD length = 0;
  if (caption == NULL) return FALSE;
  while (caption[length] != L'\0') {
    if (length >= CLOCK_CAPTION_CAPACITY - 1) return FALSE;
    length++;
  }
  return TRUE;
}

static VOID CALLBACK ActionsTimer(HWND closeButton, UINT message, UINT_PTR timer, DWORD tick) {
  HWND openButton = NULL;
  WCHAR openCaption[CLOCK_CAPTION_CAPACITY];
  WCHAR closeCaption[CLOCK_CAPTION_CAPACITY];
  DWORD length;
  BOOL render = FALSE;
  (void)message;
  (void)tick;
  /* Old queued callbacks must not affect a restarted timer or a reused HWND. */
  AcquireSRWLockExclusive(&clockLock);
  if (pendingActions.closeButton == closeButton && pendingActions.timer == timer
      && (UINT_PTR)GetPropW(closeButton, actionsTimerProperty) == timer) {
    KillTimer(closeButton, timer);
    RemovePropW(closeButton, actionsTimerProperty);
    openButton = pendingActions.openButton;
    for (length = 0; length < CLOCK_CAPTION_CAPACITY; length++) {
      openCaption[length] = pendingActions.openCaption[length];
      closeCaption[length] = pendingActions.closeCaption[length];
    }
    pendingActions.openButton = NULL;
    pendingActions.closeButton = NULL;
    pendingActions.timer = 0;
    pendingActions.openCaption[0] = L'\0';
    pendingActions.closeCaption[0] = L'\0';
    render = TRUE;
  }
  ReleaseSRWLockExclusive(&clockLock);
  if (!render || !OwnsActions(openButton, closeButton)) return;
  SetWindowTextW(openButton, openCaption);
  EnableWindow(openButton, TRUE);
  ShowWindow(openButton, SW_SHOWNOACTIVATE);
  SetWindowTextW(closeButton, closeCaption);
  EnableWindow(closeButton, TRUE);
  ShowWindow(closeButton, SW_SHOWNOACTIVATE);
}

BOOL WINAPI CompleteActions(HWND openButton, LPCWSTR openCaption, HWND closeButton, LPCWSTR closeCaption) {
  DWORD length = 0;
  UINT_PTR timer;

  if (!CaptionFits(openCaption) || !CaptionFits(closeCaption)
      || !OwnsActions(openButton, closeButton) || !PinModule()) return FALSE;
  AcquireSRWLockExclusive(&clockLock);
  if (pendingActions.timer != 0) {
    KillTimer(pendingActions.closeButton, pendingActions.timer);
    if ((UINT_PTR)GetPropW(pendingActions.closeButton, actionsTimerProperty) == pendingActions.timer) {
      RemovePropW(pendingActions.closeButton, actionsTimerProperty);
    }
  }
  pendingActions.openButton = NULL;
  pendingActions.closeButton = NULL;
  pendingActions.timer = 0;
  pendingActions.openCaption[0] = L'\0';
  pendingActions.closeCaption[0] = L'\0';
  nextTimer++;
  if (nextTimer == 0) nextTimer++;
  timer = nextTimer;
  if (!SetPropW(closeButton, actionsTimerProperty, (HANDLE)timer)) {
    ReleaseSRWLockExclusive(&clockLock);
    return FALSE;
  }
  if (SetTimer(closeButton, timer, 20, ActionsTimer) == 0) {
    RemovePropW(closeButton, actionsTimerProperty);
    ReleaseSRWLockExclusive(&clockLock);
    return FALSE;
  }
  for (length = 0; openCaption[length] != L'\0'; length++) pendingActions.openCaption[length] = openCaption[length];
  pendingActions.openCaption[length] = L'\0';
  for (length = 0; closeCaption[length] != L'\0'; length++) pendingActions.closeCaption[length] = closeCaption[length];
  pendingActions.closeCaption[length] = L'\0';
  pendingActions.openButton = openButton;
  pendingActions.closeButton = closeButton;
  pendingActions.timer = timer;
  ReleaseSRWLockExclusive(&clockLock);
  return TRUE;
}
