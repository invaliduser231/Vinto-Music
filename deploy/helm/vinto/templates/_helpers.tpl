{{- define "vinto.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "vinto.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "vinto.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "vinto.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "vinto.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vinto.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "vinto.secretName" -}}
{{- required "secret.name is required, create the secret from your .env first" .Values.secret.name }}
{{- end }}

{{- define "vinto.image" -}}
{{- printf "%s:%s" .repository (toString .tag) }}
{{- end }}

{{- define "vinto.env" -}}
{{- range $key, $value := . }}
- name: {{ $key }}
  value: {{ toString $value | quote }}
{{- end }}
{{- end }}

{{- define "vinto.podSpecCommon" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
automountServiceAccountToken: false
enableServiceLinks: false
{{- with .Values.podSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "vinto.containerSecurity" -}}
{{- with .Values.containerSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "vinto.appHeadless" -}}
{{- printf "%s-app" (include "vinto.fullname" .) }}
{{- end }}

{{- define "vinto.nodelinkUrl" -}}
{{- printf "http://%s-nodelink:%d" (include "vinto.fullname" .) (int .Values.nodelink.port) }}
{{- end }}

{{- define "vinto.cipherUrl" -}}
{{- if .Values.ytCipher.enabled }}
{{- printf "http://%s-yt-cipher:%d" (include "vinto.fullname" .) (int .Values.ytCipher.port) }}
{{- else }}
{{- required "ytCipher.externalUrl is required when ytCipher is disabled" .Values.ytCipher.externalUrl }}
{{- end }}
{{- end }}
