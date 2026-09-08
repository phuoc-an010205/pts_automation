PTS Worker failed to start PhotoshopControllerError: Failed to start Windows Photoshop controller
      at start (B:/~BUN/root/worker.exe:41111:13)
      at async initialize (B:/~BUN/root/worker.exe:41467:34)
      at async <anonymous> (B:/~BUN/root/worker.exe:42203:32)
      at async <anonymous> (B:/~BUN/root/worker.exe:42322:37)

1085 |   if (!isURLInstance(fileURLOrPath))
1086 |     return fileURLOrPath;
1087 |   return Bun.fileURLToPath(fileURLOrPath);
1088 | }
1089 | var { Error, TypeError } = globalThis;
1090 |   let err = new Error(message);
                   ^
error: Command failed: start  C:\Program Files\Adobe\Adobe Photoshop 2024\Photoshop.exe
The system cannot find the file C:\Program.

   code: 1,
 killed: false,
 signal: null,
    cmd: "start  C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe",
 stdout: "",
 stderr: "The system cannot find the file C:\\Program.\r\n",

      at genericNodeError (node:child_process:1090:13)
      at exitHandler (node:child_process:115:28)
      at emit (node:events:103:22)
      at #maybeClose (node:child_process:836:16)
      at #handleOnExit (node:child_process:583:72)
