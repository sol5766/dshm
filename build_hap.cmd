@echo off
set JAVA_HOME=C:\Program Files\Huawei\DevEco Studio\jbr
set PATH=%JAVA_HOME%\bin;%PATH%
set DEVECO_SDK_HOME=C:\Program Files\Huawei\DevEco Studio\sdk
"C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe" "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" %* --mode module -p product=default assembleHap
