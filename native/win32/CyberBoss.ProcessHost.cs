using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        int parentPid;
        if (args.Length < 2 || !int.TryParse(args[0], out parentPid))
        {
            Console.Error.WriteLine("usage: CyberBoss.ProcessHost.exe <parent-pid> <command> [args...]");
            return 64;
        }

        IntPtr job = IntPtr.Zero;
        Process child = null;
        try
        {
            job = CreateKillOnCloseJob();
            var startInfo = new ProcessStartInfo
            {
                FileName = args[1],
                Arguments = BuildArguments(args, 2),
                WorkingDirectory = Environment.CurrentDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            child = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            child.OutputDataReceived += (_, eventArgs) => { if (eventArgs.Data != null) Console.Out.WriteLine(eventArgs.Data); };
            child.ErrorDataReceived += (_, eventArgs) => { if (eventArgs.Data != null) Console.Error.WriteLine(eventArgs.Data); };
            if (!child.Start()) throw new InvalidOperationException("child process did not start");
            if (!AssignProcessToJobObject(job, child.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            Console.Error.WriteLine("[cyberboss-process-host] child-pid=" + child.Id);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            while (!child.HasExited)
            {
                if (!IsProcessAlive(parentPid)) return 70;
                Thread.Sleep(250);
            }
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[cyberboss-process-host] " + error.GetType().Name + ": " + error.Message);
            return 71;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child != null) child.Dispose();
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
        finally { Marshal.FreeHGlobal(pointer); }
        return job;
    }

    private static bool IsProcessAlive(int pid)
    {
        try { using (var process = Process.GetProcessById(pid)) return !process.HasExited; }
        catch { return false; }
    }

    private static string BuildArguments(string[] args, int start)
    {
        var writer = new StringWriter();
        for (int index = start; index < args.Length; index++)
        {
            if (index > start) writer.Write(' ');
            writer.Write(QuoteArgument(args[index]));
        }
        return writer.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var writer = new StringWriter();
        writer.Write('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                writer.Write(new string('\\', slashes * 2 + 1));
                writer.Write('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) { writer.Write(new string('\\', slashes)); slashes = 0; }
            writer.Write(character);
        }
        if (slashes > 0) writer.Write(new string('\\', slashes * 2));
        writer.Write('"');
        return writer.ToString();
    }
}
