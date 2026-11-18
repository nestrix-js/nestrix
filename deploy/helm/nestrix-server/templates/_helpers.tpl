{{- define "nestrix-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nestrix-server.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "nestrix-server.postgresName" -}}
{{- printf "%s-postgres" (include "nestrix-server.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nestrix-server.labels" -}}
app.kubernetes.io/name: {{ include "nestrix-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nestrix-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nestrix-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "nestrix-server.postgresSelectorLabels" -}}
app.kubernetes.io/name: {{ include "nestrix-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}

{{/* repository:tag@digest, or repository:tag without a digest */}}
{{- define "nestrix-server.image" -}}
{{- if .digest -}}
{{- printf "%s:%s@%s" .repository .tag .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "nestrix-server.secretName" -}}
{{- required "existingSecret.name is required: create the Secret (see README.md) and set existingSecret.name" .Values.existingSecret.name -}}
{{- end -}}
