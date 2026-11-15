param([switch]$Test)
$ErrorActionPreference='Stop'
# Uses Windows' notification service, with no app restart, browser or mail.
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null
$title='Prompt Predictor needs attention'
$message='Prediction tracking has a persistent problem. Run Status.cmd in your Prompt Predictor installation for diagnosis.'
if($Test){$title='Prompt Predictor monitor installed';$message='Windows alert delivery test. Routine healthy checks stay quiet.'}
$xml=New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>'+[Security.SecurityElement]::Escape($title)+'</text><text>'+[Security.SecurityElement]::Escape($message)+'</text></binding></visual></toast>')
$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)
