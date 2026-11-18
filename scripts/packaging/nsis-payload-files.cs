using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class InstallerPayloadFiles
{
    private const uint ReadAttributes = 0x80;
    private const uint ShareReadWrite = 3;
    private const uint ShareDelete = 4;
    private const uint OpenExisting = 3;
    private const uint OpenDirectoryWithoutFollowingLinks = 0x02200000;
    private const uint DirectoryAttribute = 0x10;
    private const uint ReparseAttribute = 0x400;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool RemoveDirectoryW(string path);

    private static SafeFileHandle OpenEntry(string path, uint share)
    {
        var handle = CreateFileW(
            path, ReadAttributes, share, IntPtr.Zero, OpenExisting,
            OpenDirectoryWithoutFollowingLinks, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, path);
        }
        return handle;
    }

    private static FileInformation GetInformation(SafeFileHandle handle)
    {
        FileInformation information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return information;
    }

    public static string Identity(string path)
    {
        using (var handle = OpenEntry(path, ShareReadWrite | ShareDelete))
        {
            var information = GetInformation(handle);
            if ((information.Attributes & ReparseAttribute) != 0)
                throw new IOException("A payload path is a reparse point: " + path);
            var index = ((ulong)information.IndexHigh << 32) | information.IndexLow;
            if (index == 0)
                throw new IOException("The file system did not provide a file identity: " + path);
            return index.ToString(CultureInfo.InvariantCulture);
        }
    }

    public static void Rename(string source, string destination)
    {
        // No copy, replacement or reboot fallback.
        if (!MoveFileExW(source, destination, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not move " + source);
    }

    public static void DeleteStagedTree(string root, string work, string path)
    {
        using (var rootHandle = OpenEntry(root, ShareReadWrite))
        using (var workHandle = OpenEntry(work, ShareReadWrite))
        {
            if ((GetInformation(rootHandle).Attributes & (DirectoryAttribute | ReparseAttribute)) != DirectoryAttribute ||
                (GetInformation(workHandle).Attributes & (DirectoryAttribute | ReparseAttribute)) != DirectoryAttribute)
                throw new IOException("The upgrade directory is no longer an ordinary directory.");
            DeleteTree(path);
        }
    }

    private static void DeleteTree(string path)
    {
        // Keep each directory open without delete sharing while visiting its
        // children. A junction or mount point is removed as a leaf.
        using (var handle = OpenEntry(path, ShareReadWrite))
        {
            var information = GetInformation(handle);
            if ((information.Attributes & DirectoryAttribute) == 0)
                throw new IOException("Expected a cleanup directory: " + path);
            if ((information.Attributes & ReparseAttribute) == 0)
            {
                // Reuse the attributes returned by enumeration so deleting a
                // file needs no separate attribute lookup.
                foreach (var entry in new DirectoryInfo(path).EnumerateFileSystemInfos())
                {
                    if ((entry.Attributes & FileAttributes.Directory) != 0)
                        DeleteTree(entry.FullName);
                    else
                        File.Delete(entry.FullName);
                }
            }
        }
        if (!RemoveDirectoryW(path))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not remove " + path);
    }
}
