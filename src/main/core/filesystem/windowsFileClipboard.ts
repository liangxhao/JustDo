import { execFile } from 'child_process';
import path from 'path';

export interface WindowsFileClipboardSnapshot {
  paths: string[];
  mode: 'copy' | 'move';
  revision: string;
}

export interface WindowsFileClipboardPasteResult {
  cancelled: boolean;
  clipboard: WindowsFileClipboardSnapshot;
}

export interface WindowsFileIdentity {
  dev: string;
  ino: string;
}

export interface WindowsFileMutationIdentity extends WindowsFileIdentity {
  parentDev: string;
  parentIno: string;
}

const MAX_CLIPBOARD_PATHS = 10_000;
const MAX_HELPER_BYTES = 8 * 1024 * 1024;
const ClipboardAction = {
  Read: 'read',
  Write: 'write',
  Paste: 'paste',
  Rename: 'rename',
  Trash: 'trash',
} as const;

const WINDOWS_NATIVE_FILE_CLIPBOARD_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class NativeFileClipboardSnapshot {
  public string[] paths;
  public string mode;
  public string revision;
}

public sealed class NativeFilePasteResult {
  public bool cancelled;
  public NativeFileClipboardSnapshot clipboard;
}

public class NativeFileIdentity {
  public string dev;
  public string ino;
}

public sealed class NativeFileMutationIdentity : NativeFileIdentity {
  public string parentDev;
  public string parentIno;
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileClipboardShellItem {
  [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
  [PreserveSig] int GetParent(out IFileClipboardShellItem parent);
  [PreserveSig] int GetDisplayName(uint form, out IntPtr name);
  [PreserveSig] int GetAttributes(uint mask, out uint attributes);
  [PreserveSig] int Compare(IFileClipboardShellItem item, uint hint, out int order);
}

// IFileOperationProgressSink, in the Windows SDK's exact native vtable order.
[ComVisible(true), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileClipboardProgressSink {
  [PreserveSig] int StartOperations();
  [PreserveSig] int FinishOperations(int result);
  [PreserveSig] int PreRenameItem(uint flags, IFileClipboardShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostRenameItem(uint flags, IFileClipboardShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IFileClipboardShellItem created);
  [PreserveSig] int PreMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IFileClipboardShellItem created);
  [PreserveSig] int PreCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IFileClipboardShellItem created);
  [PreserveSig] int PreDeleteItem(uint flags, IFileClipboardShellItem item);
  [PreserveSig] int PostDeleteItem(uint flags, IFileClipboardShellItem item, int result, IFileClipboardShellItem created);
  [PreserveSig] int PreNewItem(uint flags, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostNewItem(uint flags, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IFileClipboardShellItem created);
  [PreserveSig] int UpdateProgress(uint total, uint completed);
  [PreserveSig] int ResetTimer();
  [PreserveSig] int PauseTimer();
  [PreserveSig] int ResumeTimer();
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class RecycleOnlyProgressSink : IFileClipboardProgressSink {
  public int failure;
  public bool refused;
  private readonly string sourcePath;
  private readonly NativeFileMutationIdentity identity;
  public RecycleOnlyProgressSink(string sourcePath, NativeFileMutationIdentity identity) {
    this.sourcePath = sourcePath;
    this.identity = identity;
  }
  public int StartOperations() { return 0; }
  public int FinishOperations(int result) { return 0; }
  public int PreRenameItem(uint flags, IFileClipboardShellItem item, string name) { return 0; }
  public int PostRenameItem(uint flags, IFileClipboardShellItem item, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name) { return 0; }
  public int PostMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name) { return 0; }
  public int PostCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreDeleteItem(uint flags, IFileClipboardShellItem item) {
    // Match Electron 42.7's recycle-only gate: TSF_DELETE_RECYCLE_IF_POSSIBLE
    // is absent when the Shell would permanently delete this item instead.
    if ((flags & 0x80) != 0) {
      try { NativeFileClipboard.AssertMutationIdentity(sourcePath, identity); return 0; }
      catch { }
    }
    refused = true;
    return unchecked((int)0x80004004); // E_ABORT; never consent to permanent delete.
  }
  public int PostDeleteItem(uint flags, IFileClipboardShellItem item, int result, IFileClipboardShellItem created) {
    if (result < 0) failure = result;
    return 0;
  }
  public int PreNewItem(uint flags, IFileClipboardShellItem target, string name) { return 0; }
  public int PostNewItem(uint flags, IFileClipboardShellItem target, string name, string template, uint attributes, int result, IFileClipboardShellItem created) { return 0; }
  public int UpdateProgress(uint total, uint completed) { return 0; }
  public int ResetTimer() { return 0; }
  public int PauseTimer() { return 0; }
  public int ResumeTimer() { return 0; }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class FileTransferProgressSink : IFileClipboardProgressSink {
  public bool refused;
  private readonly string targetDirectory;
  private readonly NativeFileIdentity identity;
  public FileTransferProgressSink(string targetDirectory, NativeFileIdentity identity) {
    this.targetDirectory = targetDirectory;
    this.identity = identity;
  }
  private int BeforeItem(IFileClipboardShellItem item, IFileClipboardShellItem target, string name) {
    try {
      NativeFileClipboard.AssertTransferDestination(targetDirectory, identity, item, target, name);
      return 0;
    } catch {
      refused = true;
      return unchecked((int)0x80004004);
    }
  }
  public int StartOperations() { return 0; }
  public int FinishOperations(int result) { return 0; }
  public int PreRenameItem(uint flags, IFileClipboardShellItem item, string name) { return 0; }
  public int PostRenameItem(uint flags, IFileClipboardShellItem item, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name) { return BeforeItem(item, target, name); }
  public int PostMoveItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name) { return BeforeItem(item, target, name); }
  public int PostCopyItem(uint flags, IFileClipboardShellItem item, IFileClipboardShellItem target, string name, int result, IFileClipboardShellItem created) { return 0; }
  public int PreDeleteItem(uint flags, IFileClipboardShellItem item) { return 0; }
  public int PostDeleteItem(uint flags, IFileClipboardShellItem item, int result, IFileClipboardShellItem created) { return 0; }
  public int PreNewItem(uint flags, IFileClipboardShellItem target, string name) { return BeforeItem(null, target, name); }
  public int PostNewItem(uint flags, IFileClipboardShellItem target, string name, string template, uint attributes, int result, IFileClipboardShellItem created) { return 0; }
  public int UpdateProgress(uint total, uint completed) { return 0; }
  public int ResetTimer() { return 0; }
  public int PauseTimer() { return 0; }
  public int ResumeTimer() { return 0; }
}

// Keep every method in native vtable order, including the unused slots.
[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileClipboardOperation {
  [PreserveSig] int Advise(IFileClipboardProgressSink sink, out uint cookie);
  [PreserveSig] int Unadvise(uint cookie);
  [PreserveSig] int SetOperationFlags(uint flags);
  [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
  [PreserveSig] int SetProgressDialog(IntPtr dialog);
  [PreserveSig] int SetProperties(IntPtr properties);
  [PreserveSig] int SetOwnerWindow(IntPtr owner);
  [PreserveSig] int ApplyPropertiesToItem(IFileClipboardShellItem item);
  [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
  [PreserveSig] int RenameItem(IFileClipboardShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
  [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int MoveItem(IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
  [PreserveSig] int MoveItems(IntPtr items, IFileClipboardShellItem target);
  [PreserveSig] int CopyItem(IFileClipboardShellItem item, IFileClipboardShellItem target, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
  [PreserveSig] int CopyItems(IntPtr items, IFileClipboardShellItem target);
  [PreserveSig] int DeleteItem(IFileClipboardShellItem item, IFileClipboardProgressSink sink);
  [PreserveSig] int DeleteItems(IntPtr items);
  [PreserveSig] int NewItem(IFileClipboardShellItem target, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
  [PreserveSig] int PerformOperations();
  [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}

public static class NativeFileClipboard {
  private const string PreferredEffect = "Preferred DropEffect";
  private const uint CopyEffect = 1;
  private const uint MoveEffect = 2;
  private const uint RenameOnCollision = 0x0008;
  private const uint PreserveExtensions = 0x00200000;
  // Operate on exactly the admitted items; HTML companion folders must not be
  // moved behind the application's preview-transition guard.
  private const uint OperationFlags = 0x0040 | 0x0200 | 0x2000 | 0x20000000;
  // FOF_NO_UI + NO_CONNECTED_ELEMENTS + ADDUNDORECORD + RECYCLEONDELETE +
  // EARLYFAILURE. The progress sink, rather than flags alone, vetoes deletion
  // when recycling is unavailable. No permanent-deletion fallback exists.
  private const uint RecycleFlags = 0x0614 | 0x2000 | 0x20000000 | 0x00080000 | 0x00100000;

  [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseClipboard();
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EmptyClipboard();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHCreateItemFromParsingName(string name, IntPtr binding, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IFileClipboardShellItem item);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileExW(string existingName, string newName, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out FileIdentityInformation information);
  [DllImport("kernel32.dll")] private static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdentityInformation {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME creationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME lastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME lastWriteTime;
    public uint volumeSerial;
    public uint fileSizeHigh;
    public uint fileSizeLow;
    public uint numberOfLinks;
    public uint fileIndexHigh;
    public uint fileIndexLow;
  }

  private static string Revision() {
    return GetClipboardSequenceNumber().ToString(CultureInfo.InvariantCulture);
  }

  private static void Check(int result) {
    if (result < 0) Marshal.ThrowExceptionForHR(result);
  }

  private static void CheckPaths(string[] paths) {
    if (paths == null || paths.Length > 10000) throw new ArgumentException("invalid-paths");
    foreach (string file in paths) {
      if (String.IsNullOrEmpty(file) || file.IndexOf('\0') >= 0 || !Path.IsPathRooted(file)) {
        throw new ArgumentException("invalid-paths");
      }
    }
  }

  private static NativeFileClipboardSnapshot ReadOnce() {
    string revision = Revision();
    IDataObject data = Clipboard.GetDataObject();
    string[] paths = new string[0];
    uint effect = CopyEffect;
    if (data != null && data.GetDataPresent(DataFormats.FileDrop, false)) {
      object fileDrop = data.GetData(DataFormats.FileDrop, false);
      paths = fileDrop as string[];
      if (paths == null) throw new InvalidOperationException("invalid-file-drop");
      CheckPaths(paths);
      if (data.GetDataPresent(PreferredEffect, false)) {
        Stream stream = data.GetData(PreferredEffect, false) as Stream;
        if (stream != null) {
          long position = stream.CanSeek ? stream.Position : 0;
          try {
            if (stream.CanSeek) stream.Position = 0;
            byte[] bytes = new byte[4];
            int offset = 0;
            while (offset < bytes.Length) {
              int count = stream.Read(bytes, offset, bytes.Length - offset);
              if (count == 0) break;
              offset += count;
            }
            if (offset == 4) effect = BitConverter.ToUInt32(bytes, 0);
          } finally {
            if (stream.CanSeek) stream.Position = position;
          }
        }
      }
    }
    if (revision != Revision()) throw new InvalidOperationException("clipboard-changed");
    return new NativeFileClipboardSnapshot {
      paths = paths,
      mode = (effect & MoveEffect) != 0 ? "move" : "copy",
      revision = revision
    };
  }

  public static NativeFileClipboardSnapshot Read() {
    try { return ReadOnce(); }
    catch (InvalidOperationException error) {
      if (error.Message != "clipboard-changed") throw;
    }
    // Rendering a delayed native FileDrop can itself advance the sequence.
    // Re-read data and effect once to obtain a stable snapshot. Mutations and
    // native file operations are never retried, and Paste still matches the
    // complete snapshot against its original, reviewed expectation.
    return ReadOnce();
  }

  public static NativeFileClipboardSnapshot Write(string[] paths, string mode) {
    CheckPaths(paths);
    if (paths.Length == 0 || (mode != "copy" && mode != "move")) throw new ArgumentException("invalid-file-drop");
    StringCollection files = new StringCollection();
    files.AddRange(paths);
    DataObject data = new DataObject();
    data.SetFileDropList(files);
    using (MemoryStream effect = new MemoryStream(BitConverter.GetBytes(mode == "move" ? MoveEffect : CopyEffect))) {
      data.SetData(PreferredEffect, false, effect);
      // Flush the OLE data so it survives this short-lived helper process.
      Clipboard.SetDataObject(data, true, 0, 0);
    }
    return Read();
  }

  private static bool Matches(NativeFileClipboardSnapshot current, string[] paths, string mode, string revision) {
    if (current.revision != revision || current.mode != mode || current.paths.Length != paths.Length) return false;
    for (int index = 0; index < paths.Length; index++) {
      if (!String.Equals(current.paths[index], paths[index], StringComparison.Ordinal)) return false;
    }
    return true;
  }

  private static string FullPath(string value) {
    return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  }

  private static bool SourceExists(string value) {
    try { File.GetAttributes(value); return true; }
    catch (FileNotFoundException) { return false; }
    catch (DirectoryNotFoundException) { return false; }
  }

  private static void CheckTargetDirectory(string value) {
    // Main supplies a canonical target. Reject a directory replaced with a link
    // while this helper was starting, including links in any ancestor.
    DirectoryInfo directory = new DirectoryInfo(Path.GetFullPath(value));
    while (directory != null) {
      if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) {
        throw new InvalidOperationException("paste-target-changed");
      }
      directory = directory.Parent;
    }
  }

  private static void CheckName(string name) {
    if (String.IsNullOrWhiteSpace(name) || name.Length > 255 || name == "." || name == ".." ||
        name.EndsWith(" ", StringComparison.Ordinal) || name.EndsWith(".", StringComparison.Ordinal) ||
        name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) {
      throw new ArgumentException("invalid-name");
    }
    string stem = name.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
        stem == "CONIN$" || stem == "CONOUT$" ||
        (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) &&
         "123456789\u00b9\u00b2\u00b3".IndexOf(stem[3]) >= 0)) {
      throw new ArgumentException("invalid-name");
    }
  }

  private static void AssertFileIdentity(string filePath, string expectedDev, string expectedIno, bool directory) {
    ulong dev;
    ulong ino;
    if (!UInt64.TryParse(expectedDev, NumberStyles.None, CultureInfo.InvariantCulture, out dev) ||
        !UInt64.TryParse(expectedIno, NumberStyles.None, CultureInfo.InvariantCulture, out ino)) {
      throw new ArgumentException("invalid-file-identity");
    }
    // OPEN_REPARSE_POINT prevents following a replaced leaf. BACKUP_SEMANTICS
    // permits a directory handle; share-delete lets the subsequent rename run.
    IntPtr handle = CreateFileW(filePath, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      FileIdentityInformation information;
      if (!GetFileInformationByHandle(handle, out information)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      ulong fileIndex = ((ulong)information.fileIndexHigh << 32) | information.fileIndexLow;
      if (GetFileType(handle) != 1 ||
          (information.attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Device)) != 0 ||
          (directory && (information.attributes & (uint)FileAttributes.Directory) == 0) ||
          dev != information.volumeSerial || ino != fileIndex) {
        throw new InvalidOperationException("workspace-item-changed");
      }
    } finally { CloseHandle(handle); }
  }

  internal static void AssertMutationIdentity(string source, NativeFileMutationIdentity identity) {
    if (identity == null) throw new ArgumentException("invalid-file-identity");
    string parent = Path.GetDirectoryName(source);
    if (String.IsNullOrEmpty(parent)) throw new ArgumentException("invalid-source");
    CheckTargetDirectory(parent);
    AssertFileIdentity(parent, identity.parentDev, identity.parentIno, true);
    AssertFileIdentity(source, identity.dev, identity.ino, false);
  }

  private static void AssertDirectoryIdentity(string target, NativeFileIdentity identity) {
    if (identity == null) throw new ArgumentException("invalid-file-identity");
    CheckTargetDirectory(target);
    AssertFileIdentity(target, identity.dev, identity.ino, true);
  }

  public static void Rename(string sourcePath, string newName, NativeFileMutationIdentity identity) {
    CheckPaths(new string[] { sourcePath });
    CheckName(newName);
    string source = Path.GetFullPath(sourcePath);
    AssertMutationIdentity(source, identity);
    string parent = Path.GetDirectoryName(source);
    if (String.Equals(Path.GetFileName(source), newName, StringComparison.Ordinal)) return;
    string target = Path.Combine(parent, newName);
    // No MOVEFILE_REPLACE_EXISTING: collisions fail atomically. Windows still
    // permits an existing item to change only its filename's letter case.
    if (!MoveFileExW(source, target, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 80 || error == 183) throw new InvalidOperationException("already-exists");
      throw new System.ComponentModel.Win32Exception(error);
    }
  }

  public static void Trash(string sourcePath, NativeFileMutationIdentity identity) {
    CheckPaths(new string[] { sourcePath });
    string source = Path.GetFullPath(sourcePath);
    AssertMutationIdentity(source, identity);
    object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
    IFileClipboardOperation operation = (IFileClipboardOperation)instance;
    IFileClipboardShellItem item = null;
    RecycleOnlyProgressSink sink = new RecycleOnlyProgressSink(source, identity);
    try {
      Check(operation.SetOperationFlags(RecycleFlags));
      AssertMutationIdentity(source, identity);
      item = ShellItem(source);
      Check(operation.DeleteItem(item, sink));
      AssertMutationIdentity(source, identity);
      int result = operation.PerformOperations();
      bool aborted;
      Check(operation.GetAnyOperationsAborted(out aborted));
      if (sink.refused || aborted) throw new InvalidOperationException("recycle-unavailable-or-cancelled");
      Check(result);
      Check(sink.failure);
    } finally {
      if (item != null) Marshal.ReleaseComObject(item);
      Marshal.ReleaseComObject(instance);
      GC.KeepAlive(sink);
    }
  }

  private static IntPtr OwnerHandle(string value) {
    if (String.IsNullOrEmpty(value)) return IntPtr.Zero;
    long handle = value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
      ? Int64.Parse(value.Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture)
      : Int64.Parse(value, CultureInfo.InvariantCulture);
    return new IntPtr(handle);
  }

  private static IFileClipboardShellItem ShellItem(string file) {
    Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
    IFileClipboardShellItem item;
    Check(SHCreateItemFromParsingName(file, IntPtr.Zero, ref iid, out item));
    return item;
  }

  private static string ShellPath(IFileClipboardShellItem item) {
    if (item == null) throw new InvalidOperationException("invalid-transfer-item");
    IntPtr value = IntPtr.Zero;
    try {
      Check(item.GetDisplayName(0x80058000, out value)); // SIGDN_FILESYSPATH
      string file = Marshal.PtrToStringUni(value);
      if (String.IsNullOrEmpty(file) || !Path.IsPathRooted(file)) {
        throw new InvalidOperationException("invalid-transfer-item");
      }
      return file;
    } finally {
      if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value);
    }
  }

  private static bool WithinDirectory(string root, string candidate) {
    string directory = FullPath(root);
    string file = FullPath(candidate);
    return String.Equals(directory, file, StringComparison.OrdinalIgnoreCase) ||
      file.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
  }

  internal static void AssertTransferDestination(string root, NativeFileIdentity identity, IFileClipboardShellItem item, IFileClipboardShellItem target, string name) {
    AssertDirectoryIdentity(root, identity);
    string parent = ShellPath(target);
    if (!WithinDirectory(root, parent)) throw new InvalidOperationException("paste-target-changed");
    CheckTargetDirectory(parent);
    if (String.IsNullOrEmpty(name)) name = Path.GetFileName(FullPath(ShellPath(item)));
    CheckName(name);
    string destination = Path.Combine(parent, name);
    if (!WithinDirectory(root, destination)) throw new InvalidOperationException("paste-target-changed");
    FileAttributes attributes;
    try { attributes = File.GetAttributes(destination); }
    catch (FileNotFoundException) { return; }
    catch (DirectoryNotFoundException) { return; }
    // Directory merges are reported recursively by the global progress sink.
    // Reject the leaf too: a target/foo junction otherwise redirects the Shell's
    // folder merge before its child callback can inspect the destination parent.
    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) {
      throw new InvalidOperationException("paste-target-changed");
    }
  }

  private static bool Perform(List<string> sources, string targetDirectory, string mode, IntPtr owner, bool rename, NativeFileIdentity targetIdentity) {
    if (sources.Count == 0) return false;
    object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
    IFileClipboardOperation operation = (IFileClipboardOperation)instance;
    List<IFileClipboardShellItem> items = new List<IFileClipboardShellItem>();
    IFileClipboardShellItem target = null;
    FileTransferProgressSink sink = new FileTransferProgressSink(targetDirectory, targetIdentity);
    uint cookie = 0;
    bool advised = false;
    try {
      Check(operation.Advise(sink, out cookie));
      advised = true;
      Check(operation.SetOwnerWindow(owner));
      Check(operation.SetOperationFlags(OperationFlags | (rename ? RenameOnCollision | PreserveExtensions : 0)));
      AssertDirectoryIdentity(targetDirectory, targetIdentity);
      target = ShellItem(targetDirectory);
      foreach (string source in sources) {
        IFileClipboardShellItem item = ShellItem(source);
        items.Add(item);
        Check(mode == "move"
          ? operation.MoveItem(item, target, null, IntPtr.Zero)
          : operation.CopyItem(item, target, null, IntPtr.Zero));
      }
      AssertDirectoryIdentity(targetDirectory, targetIdentity);
      int result = operation.PerformOperations();
      bool aborted;
      Check(operation.GetAnyOperationsAborted(out aborted));
      AssertDirectoryIdentity(targetDirectory, targetIdentity);
      if (sink.refused) throw new InvalidOperationException("paste-target-changed");
      if (aborted) return true;
      Check(result);
      return false;
    } finally {
      if (advised) operation.Unadvise(cookie);
      foreach (IFileClipboardShellItem item in items) Marshal.ReleaseComObject(item);
      if (target != null) Marshal.ReleaseComObject(target);
      Marshal.ReleaseComObject(instance);
      GC.KeepAlive(sink);
    }
  }

  private static void ClearUnchanged(string revision) {
    // Holding the clipboard open makes the compare-and-clear atomic with respect
    // to other applications publishing a newer clipboard payload.
    if (!OpenClipboard(IntPtr.Zero)) return;
    try {
      if (Revision() == revision) EmptyClipboard();
    } finally {
      CloseClipboard();
    }
  }

  public static NativeFilePasteResult Paste(string[] paths, string mode, string revision, string targetDirectory, string ownerHandle, NativeFileIdentity targetIdentity) {
    CheckPaths(paths);
    if (paths.Length == 0 || (mode != "copy" && mode != "move")) throw new ArgumentException("invalid-file-drop");
    if (!Matches(Read(), paths, mode, revision)) throw new InvalidOperationException("clipboard-changed");
    AssertDirectoryIdentity(targetDirectory, targetIdentity);
    IntPtr owner = OwnerHandle(ownerHandle);
    List<string> regular = new List<string>();
    List<string> sameDirectoryCopies = new List<string>();
    foreach (string source in paths) {
      // A cancelled multi-item move can leave already moved paths on the native
      // clipboard. Match the entire original payload above, then operate only on
      // remaining references. Permission and other errors are not missing files.
      if (!SourceExists(source)) continue;
      string parent = Path.GetDirectoryName(source);
      bool sameDirectory = !String.IsNullOrEmpty(parent) && String.Equals(FullPath(parent), FullPath(targetDirectory), StringComparison.OrdinalIgnoreCase);
      if (sameDirectory && mode == "move") continue;
      if (sameDirectory) sameDirectoryCopies.Add(source);
      else regular.Add(source);
    }
    bool cancelled = Perform(regular, targetDirectory, mode, owner, false, targetIdentity);
    if (!cancelled) cancelled = Perform(sameDirectoryCopies, targetDirectory, mode, owner, true, targetIdentity);
    AssertDirectoryIdentity(targetDirectory, targetIdentity);
    // A file operation has already finished here. Clipboard housekeeping must not
    // turn a completed move into an error that invites a dangerous retry.
    bool allMoved = true;
    try {
      foreach (string source in regular) {
        if (SourceExists(source)) allMoved = false;
      }
    } catch { allMoved = false; }
    if (!cancelled && mode == "move" && allMoved) {
      try { ClearUnchanged(revision); } catch { }
    }
    NativeFileClipboardSnapshot clipboard;
    try { clipboard = Read(); }
    catch {
      clipboard = new NativeFileClipboardSnapshot { paths = new string[0], mode = "copy", revision = "" };
    }
    return new NativeFilePasteResult { cancelled = cancelled, clipboard = clipboard };
  }
}
`;

// Keep the executable bootstrap small enough for Windows' command-line limit.
// The fixed native source and all data arrive on stdin. Only this module can
// supply nativeSource; paths never pass through either language's code parser.
const WINDOWS_FILE_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') -TypeDefinition ([string]$payload.nativeSource)
  if ($payload.action -eq 'rename' -or $payload.action -eq 'trash') {
    $identity = New-Object NativeFileMutationIdentity
    $identity.dev = [string]$payload.identity.dev
    $identity.ino = [string]$payload.identity.ino
    $identity.parentDev = [string]$payload.identity.parentDev
    $identity.parentIno = [string]$payload.identity.parentIno
  }
  if ($payload.action -eq 'paste') {
    $targetIdentity = New-Object NativeFileIdentity
    $targetIdentity.dev = [string]$payload.targetIdentity.dev
    $targetIdentity.ino = [string]$payload.targetIdentity.ino
  }
  switch ([string]$payload.action) {
    'read' { $result = [NativeFileClipboard]::Read() }
    'write' { $result = [NativeFileClipboard]::Write([string[]]$payload.paths, [string]$payload.mode) }
    'paste' { $result = [NativeFileClipboard]::Paste([string[]]$payload.paths, [string]$payload.mode, [string]$payload.revision, [string]$payload.targetDirectory, [string]$payload.ownerHandle, $targetIdentity) }
    'rename' { [NativeFileClipboard]::Rename([string]$payload.sourcePath, [string]$payload.newName, $identity); $result = @{ renamed = $true } }
    'trash' { [NativeFileClipboard]::Trash([string]$payload.sourcePath, $identity); $result = @{ recycled = $true } }
    default { throw 'invalid-action' }
  }
  ConvertTo-Json -InputObject $result -Depth 8 -Compress
} catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $code = if ($failure.Message -eq 'clipboard-changed') { 'clipboard-changed' } elseif ($failure.Message -eq 'already-exists') { 'already-exists' } else { 'native-file-clipboard-failed' }
  ConvertTo-Json -InputObject @{ error = $code; hresult = $failure.HResult } -Compress
  exit 1
}
`;

const asSnapshot = (value: unknown): WindowsFileClipboardSnapshot => {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid native file clipboard response.');
  const snapshot = value as Partial<WindowsFileClipboardSnapshot>;
  if (
    !Array.isArray(snapshot.paths) ||
    snapshot.paths.length > MAX_CLIPBOARD_PATHS ||
    snapshot.paths.some(file => typeof file !== 'string' || !file || file.includes('\0')) ||
    (snapshot.mode !== 'copy' && snapshot.mode !== 'move') ||
    typeof snapshot.revision !== 'string' ||
    !/^\d*$/.test(snapshot.revision)
  ) {
    throw new Error('Invalid native file clipboard response.');
  }
  return { paths: [...snapshot.paths], mode: snapshot.mode, revision: snapshot.revision };
};

export class WindowsFileClipboard {
  read(): Promise<WindowsFileClipboardSnapshot> {
    return this.invoke(ClipboardAction.Read).then(asSnapshot);
  }

  write(
    paths: string[],
    mode: WindowsFileClipboardSnapshot['mode'],
  ): Promise<WindowsFileClipboardSnapshot> {
    return this.invoke(ClipboardAction.Write, { paths, mode }).then(asSnapshot);
  }

  async rename(
    sourcePath: string,
    newName: string,
    identity: WindowsFileMutationIdentity,
  ): Promise<void> {
    const result = await this.invoke(ClipboardAction.Rename, { sourcePath, newName, identity });
    if (
      !result ||
      typeof result !== 'object' ||
      !('renamed' in result) ||
      result.renamed !== true
    ) {
      throw new Error('Invalid native file rename response.');
    }
  }

  async trash(sourcePath: string, identity: WindowsFileMutationIdentity): Promise<void> {
    const result = await this.invoke(ClipboardAction.Trash, { sourcePath, identity });
    if (
      !result ||
      typeof result !== 'object' ||
      !('recycled' in result) ||
      result.recycled !== true
    ) {
      throw new Error('Invalid native recycle response.');
    }
  }

  async paste(
    snapshot: WindowsFileClipboardSnapshot,
    targetDirectory: string,
    ownerHandle: string,
    targetIdentity: WindowsFileIdentity,
  ): Promise<WindowsFileClipboardPasteResult> {
    const validated = asSnapshot(snapshot);
    const result = await this.invoke(ClipboardAction.Paste, {
      ...validated,
      targetDirectory,
      ownerHandle,
      targetIdentity,
    });
    if (
      !result ||
      typeof result !== 'object' ||
      typeof (result as { cancelled?: unknown }).cancelled !== 'boolean'
    ) {
      throw new Error('Invalid native file paste response.');
    }
    const paste = result as WindowsFileClipboardPasteResult;
    return { cancelled: paste.cancelled, clipboard: asSnapshot(paste.clipboard) };
  }

  private invoke(
    action: (typeof ClipboardAction)[keyof typeof ClipboardAction],
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (process.platform !== 'win32') {
      return Promise.reject(new Error('Native file clipboard is only available on Windows.'));
    }
    const command = Buffer.from(WINDOWS_FILE_CLIPBOARD_SCRIPT, 'utf16le').toString('base64');
    const executable = path.win32.join(
      process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', command],
        {
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: MAX_HELPER_BYTES,
          // Native progress/conflict dialogs and large transfers have no deadline.
          timeout: action === ClipboardAction.Read || action === ClipboardAction.Write ? 15_000 : 0,
        },
        (error, stdout) => {
          let result: unknown;
          try {
            result = JSON.parse(stdout.trim());
          } catch {
            reject(new Error('Windows file clipboard helper failed.'));
            return;
          }
          const code =
            result && typeof result === 'object' && 'error' in result ? result.error : undefined;
          if (error || code) {
            const changed = code === 'clipboard-changed';
            const collision = code === 'already-exists';
            reject(
              Object.assign(
                new Error(
                  changed
                    ? 'The system clipboard changed before paste.'
                    : collision
                      ? 'A file or folder with that name already exists.'
                      : 'Windows file clipboard helper failed.',
                ),
                {
                  code: changed
                    ? 'clipboard-changed'
                    : collision
                      ? 'already-exists'
                      : 'native-file-clipboard-failed',
                },
              ),
            );
            return;
          }
          resolve(result);
        },
      );
      // execFile reports process failures through its callback. Suppress a second
      // unhandled EPIPE if a helper exits before it consumes the input.
      child.stdin?.on('error', () => {});
      child.stdin?.end(
        JSON.stringify({ ...payload, action, nativeSource: WINDOWS_NATIVE_FILE_CLIPBOARD_SOURCE }),
      );
    });
  }
}
