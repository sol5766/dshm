@echo off
set JAVA_HOME=C:\Program Files\Huawei\DevEco Studio\jbr
set DEVECO_SDK_HOME=C:\Program Files\Huawei\DevEco Studio\sdk
set PATH=%JAVA_HOME%\bin;%PATH%
call "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat" %*
