// Exchange only an owned installed .app and its exact .next/.previous sibling.
#include <sys/stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <limits.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return 2;
  char parent[PATH_MAX], resolved[PATH_MAX], app[PATH_MAX], expected[PATH_MAX];
  if (strlen(argv[1]) >= sizeof(app)) return 2;
  strcpy(app, argv[1]);
  char *slash = strrchr(app, '/');
  if (!slash || slash == app || !strstr(slash + 1, ".app")) return 2;
  const char *suffix = strrchr(slash + 1, '.');
  if (!suffix || strcmp(suffix, ".app")) return 2;
  *slash = '\0';
  if (!realpath(app, resolved) || strcmp(app, resolved)) return 2;
  if (snprintf(parent, sizeof(parent), "%s", argv[1]) >= (int)sizeof(parent)) return 2;
  if (snprintf(expected, sizeof(expected), "%s.next", parent) >= (int)sizeof(expected)) return 2;
  if (strcmp(argv[2], expected)) {
    if (snprintf(expected, sizeof(expected), "%s.previous", parent) >= (int)sizeof(expected) || strcmp(argv[2], expected)) return 2;
  }
  struct stat a, b;
  if (lstat(argv[1], &a) || lstat(argv[2], &b) || !S_ISDIR(a.st_mode) || !S_ISDIR(b.st_mode) || a.st_uid != getuid() || b.st_uid != getuid()) return 2;
  return renamex_np(argv[1], argv[2], RENAME_SWAP) == 0 ? 0 : 1;
}
